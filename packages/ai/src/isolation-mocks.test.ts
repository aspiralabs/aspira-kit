// Test-only support for the KIT-67 isolation suites (worktree, cleanup, doctor): a node:http server that
// stands in for the Neon REST API and the Cloudflare DNS API, plus fake `cloudflared` and `stripe`
// process runners over the same in-memory state. It is a .test.ts file only so tsc -p tsconfig.json
// (which excludes *.test.ts) never compiles it into dist. Nothing here talks to a live service.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

export type ProcessResult = { status: number | null; stdout: string; stderr: string }
export type ProcessRunner = (args: string[], options: { env: Record<string, string | undefined>; cwd?: string | undefined }) => ProcessResult

/** The seams the isolation module takes: HTTP base URLs for Neon and Cloudflare, process runners for cloudflared and the Stripe CLI, the port probe and a clock. */
export type MockSeams = {
  neonBaseUrl: string
  cloudflareBaseUrl: string
  cloudflared: ProcessRunner
  stripe: ProcessRunner
  probePort: (port: number) => boolean | Promise<boolean>
  now: () => Date
}

export type Branch = { id: string; name: string; parent_id: string | null; default: boolean; expires_at?: string }
export type Tunnel = { id: string; name: string }
export type Cname = { id: string; name: string; content: string }
export type Endpoint = { id: string; url: string; metadata: Record<string, string>; secret: string }
export type Event = { op: string; name: string; observed: string }

export type Mocks = {
  seams: MockSeams
  state: { branches: Branch[]; tunnels: Tunnel[]; cnames: Cname[]; endpoints: Endpoint[] }
  /** Every mutating call in order; `observed` is what `probe()` returned at that moment. */
  events: Event[]
  /** Branch names whose delete answers 500. */
  failNeonDelete: Set<string>
  /** When true, branch creation answers 500. */
  failNeonCreate: boolean
  calls: { cloudflared: string[][]; stripe: string[][] }
  /** Adds the four resources of one isolated worktree (`kit-1` -> wt/kit-1, tunnel wt-kit-1, CNAME kit-1-branch.<zone>, one tagged endpoint). */
  seed: (name: string) => void
  /** Set by a test to record what it wants to see at each mutating call (for example whether a folder still exists). */
  probe: () => string
  close: () => Promise<void>
}

export const PROJECT = 'proj-1'
export const ZONE = 'aspiralabs.co'
export const FIXED_NOW = new Date('2026-10-26T12:00:00.000Z')
const DEFAULT_BRANCH = { id: 'br-main', name: 'main', parent_id: null, default: true }
const DEV_BRANCH = { id: 'br-dev', name: 'dev', parent_id: 'br-main', default: false }

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

export async function startMocks(options: { pageSize?: number } = {}): Promise<Mocks> {
  const state: Mocks['state'] = { branches: [{ ...DEFAULT_BRANCH }, { ...DEV_BRANCH }], tunnels: [], cnames: [], endpoints: [] }
  const events: Event[] = []
  const calls: Mocks['calls'] = { cloudflared: [], stripe: [] }
  const failNeonDelete = new Set<string>()
  let counter = 0
  const mocks = { failNeonCreate: false, probe: (): string => '' }
  const record = (op: string, name: string): void => {
    events.push({ op, name, observed: mocks.probe() })
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock')
      const path = url.pathname
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      const method = request.method ?? 'GET'
      // Neon: /api/v2/projects/<project>/branches[/<id>]
      const neon = /^\/api\/v2\/projects\/([^/]+)\/(?:branches(?:\/([^/]+))?|connection_uri)(?:\/(endpoints))?$/.exec(path)
      if (neon !== null) {
        const [, , branchId, sub] = neon
        if (path.endsWith('/connection_uri')) {
          const pooled = url.searchParams.get('pooled') !== 'false'
          const branch = state.branches.find((candidate) => candidate.id === url.searchParams.get('branch_id'))
          return send(200, { uri: `postgresql://owner:pw@${pooled ? 'pooler-' : ''}ep-${branch?.name.replace('/', '-') ?? 'x'}.neon.test/db?sslmode=require` })
        }
        if (method === 'GET' && branchId === undefined) return send(200, { branches: state.branches })
        if (method === 'GET' && branchId !== undefined && sub === 'endpoints') return send(200, { endpoints: [{ id: `ep-${branchId}`, type: 'read_write', host: `ep-${branchId}.neon.test` }] })
        if (method === 'GET' && branchId !== undefined) {
          const found = state.branches.find((candidate) => candidate.id === branchId)
          return found === undefined ? send(404, { message: 'branch not found' }) : send(200, { branch: found })
        }
        if (method === 'POST' && branchId === undefined) {
          if (mocks.failNeonCreate) return send(500, { message: 'neon is down' })
          const input = await body(request)
          const spec = (input.branch ?? {}) as { name?: string; parent_id?: string; expires_at?: string }
          counter += 1
          const branch: Branch = { id: `br-${String(counter)}`, name: spec.name ?? '', parent_id: spec.parent_id ?? null, default: false, ...(spec.expires_at === undefined ? {} : { expires_at: spec.expires_at }) }
          state.branches.push(branch)
          record('neon.create', branch.name)
          const host = `ep-${branch.name.replace('/', '-')}.neon.test`
          return send(201, { branch, endpoints: [{ id: `ep-${branch.id}`, type: 'read_write', host }], connection_uris: [{ connection_uri: `postgresql://owner:pw@pooler-${host}/db?sslmode=require`, connection_parameters: { host, pooler_host: `pooler-${host}` } }], operations: [] })
        }
        if (method === 'DELETE' && branchId !== undefined) {
          const found = state.branches.find((candidate) => candidate.id === branchId)
          if (found === undefined) return send(404, { message: 'branch not found' })
          if (failNeonDelete.has(found.name)) return send(500, { message: 'neon is down' })
          record('neon.delete', found.name)
          state.branches = state.branches.filter((candidate) => candidate.id !== branchId)
          return send(200, { branch: found, operations: [] })
        }
      }
      // Cloudflare: /client/v4/zones[?name=] and /client/v4/zones/<zone>/dns_records[/<id>]
      if (path === '/client/v4/zones' && method === 'GET') return send(200, { success: true, result: url.searchParams.get('name') === ZONE ? [{ id: 'zone-1', name: ZONE }] : [] })
      const dns = /^\/client\/v4\/zones\/zone-1\/dns_records(?:\/([^/]+))?$/.exec(path)
      if (dns !== null) {
        const [, id] = dns
        if (method === 'GET') {
          const name = url.searchParams.get('name')
          return send(200, { success: true, result: state.cnames.filter((cname) => name === null || cname.name === name).map((cname) => ({ ...cname, type: 'CNAME' })) })
        }
        if (method === 'POST') {
          const input = (await body(request)) as { name?: string; content?: string }
          counter += 1
          const cname = { id: `dns-${String(counter)}`, name: input.name ?? '', content: input.content ?? '' }
          state.cnames.push(cname)
          record('dns.create', cname.name)
          return send(200, { success: true, result: { ...cname, type: 'CNAME' } })
        }
        if (method === 'DELETE' && id !== undefined) {
          const found = state.cnames.find((cname) => cname.id === id)
          if (found === undefined) return send(404, { success: false, errors: [{ message: 'record not found' }] })
          record('dns.delete', found.name)
          state.cnames = state.cnames.filter((cname) => cname.id !== id)
          return send(200, { success: true, result: { id } })
        }
      }
      return send(404, { message: `no mock route for ${method} ${path}` })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  const cloudflared: ProcessRunner = (args) => {
    calls.cloudflared.push(args)
    const [group, verb] = args
    if (group !== 'tunnel') return { status: 1, stdout: '', stderr: `unexpected cloudflared ${args.join(' ')}` }
    if (verb === 'create') {
      const name = args[args.length - 1] ?? ''
      if (state.tunnels.some((tunnel) => tunnel.name === name)) return { status: 1, stdout: '', stderr: `tunnel with name ${name} already exists` }
      const tunnel = { id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`, name }
      state.tunnels.push(tunnel)
      record('tunnel.create', name)
      return { status: 0, stdout: `Created tunnel ${name} with id ${tunnel.id}\n`, stderr: '' }
    }
    if (verb === 'route') {
      const [name, host] = [args[3] ?? '', args[4] ?? '']
      const tunnel = state.tunnels.find((candidate) => candidate.name === name)
      if (tunnel === undefined || host === '') return { status: 1, stdout: '', stderr: `tunnel ${name} not found` }
      counter += 1
      state.cnames.push({ id: `dns-${String(counter)}`, name: host, content: `${tunnel.id}.cfargotunnel.com` })
      record('dns.create', host)
      return { status: 0, stdout: `Added CNAME ${host} which will route to this tunnel\n`, stderr: '' }
    }
    if (verb === 'list' || verb === 'info') {
      const name = verb === 'info' ? args[args.length - 1] : flag(args, '--name')
      const found = state.tunnels.filter((tunnel) => name === undefined || tunnel.name === name)
      if (verb === 'info' && found.length === 0) return { status: 1, stdout: '', stderr: `tunnel ${name ?? ''} not found` }
      return { status: 0, stdout: JSON.stringify(verb === 'info' ? found[0] : found), stderr: '' }
    }
    if (verb === 'delete') {
      const name = args[args.length - 1] ?? ''
      const found = state.tunnels.find((tunnel) => tunnel.name === name)
      if (found === undefined) return { status: 1, stdout: '', stderr: `tunnel ${name} not found` }
      record('tunnel.delete', name)
      state.tunnels = state.tunnels.filter((tunnel) => tunnel.name !== name)
      return { status: 0, stdout: `Deleted tunnel ${name}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }

  const stripe: ProcessRunner = (args, { env }) => {
    calls.stripe.push(args)
    if (env.STRIPE_API_KEY === undefined || env.STRIPE_API_KEY === '') return { status: 1, stdout: '', stderr: 'no API key' }
    if (args[0] !== 'webhook_endpoints') return { status: 1, stdout: '', stderr: `unexpected stripe ${args.join(' ')}` }
    const verb = args[1]
    const tagged = (endpoint: Endpoint): Endpoint & { metadata: Record<string, string> } => endpoint
    if (verb === 'list') {
      const size = Math.min(Number(flag(args, '--limit') ?? '10'), options.pageSize ?? 100)
      const after = flag(args, '--starting-after')
      const from = after === undefined ? 0 : state.endpoints.findIndex((endpoint) => endpoint.id === after) + 1
      const page = state.endpoints.slice(from, from + size)
      return { status: 0, stdout: JSON.stringify({ object: 'list', data: page.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, metadata: tagged(endpoint).metadata })), has_more: from + size < state.endpoints.length }), stderr: '' }
    }
    if (verb === 'create') {
      const joined = args.join(' ')
      const name = /aspira_worktree\W+([a-z0-9-]+)/.exec(joined)?.[1]
      counter += 1
      const endpoint: Endpoint = { id: `we_${String(counter)}`, url: flag(args, '--url') ?? '', metadata: { ...(name === undefined ? {} : { aspira_worktree: name }), ...(/aspira_kind\W+connect/.test(joined) ? { aspira_kind: 'connect' } : {}) }, secret: `whsec_${String(counter)}` }
      state.endpoints.push(endpoint)
      record('stripe.create', name ?? '')
      return { status: 0, stdout: JSON.stringify({ id: endpoint.id, url: endpoint.url, secret: endpoint.secret, metadata: endpoint.metadata }), stderr: '' }
    }
    if (verb === 'delete') {
      const id = args[2] ?? ''
      const found = state.endpoints.find((endpoint) => endpoint.id === id)
      if (found === undefined) return { status: 1, stdout: '', stderr: `No such webhook endpoint: ${id}` }
      record('stripe.delete', found.metadata.aspira_worktree ?? '')
      state.endpoints = state.endpoints.filter((endpoint) => endpoint.id !== id)
      return { status: 0, stdout: JSON.stringify({ id, deleted: true }), stderr: '' }
    }
    return { status: 1, stdout: '', stderr: `unexpected stripe ${args.join(' ')}` }
  }

  const result: Mocks = {
    seams: { neonBaseUrl: `${origin}/api/v2`, cloudflareBaseUrl: `${origin}/client/v4`, cloudflared, stripe, probePort: () => false, now: () => FIXED_NOW },
    state,
    events,
    failNeonDelete,
    get failNeonCreate() {
      return mocks.failNeonCreate
    },
    set failNeonCreate(value: boolean) {
      mocks.failNeonCreate = value
    },
    calls,
    seed(name: string) {
      counter += 1
      state.branches.push({ id: `br-seed-${name}`, name: `wt/${name}`, parent_id: 'br-dev', default: false })
      const tunnel = { id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`, name: `wt-${name}` }
      state.tunnels.push(tunnel)
      state.cnames.push({ id: `dns-seed-${name}`, name: `${name}-branch.${ZONE}`, content: `${tunnel.id}.cfargotunnel.com` })
      state.endpoints.push({ id: `we_seed_${name}`, url: `https://${name}-branch.${ZONE}/api/webhooks/stripe`, metadata: { aspira_worktree: name }, secret: `whsec_seed_${name}` })
    },
    get probe() {
      return mocks.probe
    },
    set probe(value: () => string) {
      mocks.probe = value
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
  return result
}

/** Seams that fail the test when anything uses them: the no-isolation-keys pins. */
export function forbiddenSeams(): { seams: MockSeams; used: () => string[] } {
  const used: string[] = []
  const trap = (name: string) => (): never => {
    used.push(name)
    throw new Error(`${name} seam was called, but the project has no isolation keys`)
  }
  return {
    seams: { neonBaseUrl: 'http://127.0.0.1:1/api/v2', cloudflareBaseUrl: 'http://127.0.0.1:1/client/v4', cloudflared: trap('cloudflared'), stripe: trap('stripe'), probePort: trap('probePort'), now: trap('now') },
    used: () => used,
  }
}

/** The aspira.json keys of a project that isolates its worktrees: a Neon branch, a tunnel with one Stripe webhook, and a placeholder dev URL. */
export const ISOLATION_CONFIG = {
  database: { provider: 'neon', projectId: PROJECT, parentBranch: 'dev', envVars: ['DATABASE_URL'] },
  tunnel: { zone: ZONE },
  webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed'] }],
  dev: { command: 'next dev', url: 'http://{name}.localhost:{port}' },
}

/** The process environment the live services would read; restored by the returned function. */
export function setServiceEnv(extra: Record<string, string | undefined> = {}): () => void {
  const values: Record<string, string | undefined> = { NEON_API_KEY: 'napi_test', CLOUDFLARE_API_TOKEN: 'cf_test', STRIPE_SECRET_KEY: 'sk_test_x', ...extra }
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('isolation mocks', () => {
  const open: Mocks[] = []
  afterEach(async () => {
    for (const mocks of open.splice(0)) await mocks.close()
  })

  it('seeds one worktree, lists Stripe endpoints across pages, and deletes through the same state', async () => {
    const mocks = await startMocks({ pageSize: 1 })
    open.push(mocks)
    mocks.seed('kit-1')
    mocks.seed('kit-2')
    const env = { STRIPE_API_KEY: 'sk_test_x' }
    const first = JSON.parse(mocks.seams.stripe(['webhook_endpoints', 'list', '--limit', '100'], { env }).stdout) as { data: { id: string }[]; has_more: boolean }
    expect({ count: first.data.length, more: first.has_more }).toEqual({ count: 1, more: true })
    const response = await fetch(`${mocks.seams.neonBaseUrl}/projects/${PROJECT}/branches`)
    expect(((await response.json()) as { branches: { name: string }[] }).branches.map((branch) => branch.name)).toEqual(['main', 'dev', 'wt/kit-1', 'wt/kit-2'])
    expect(mocks.seams.cloudflared(['tunnel', 'delete', 'wt-kit-1'], { env: {} }).status).toBe(0)
    expect(mocks.state.tunnels.map((tunnel) => tunnel.name)).toEqual(['wt-kit-2'])
  })
})
