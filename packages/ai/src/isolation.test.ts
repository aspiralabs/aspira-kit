// T7-T22, T37 (F2-F6, F9, F10, F14-F20, F22, F23, F29, F31): src/isolation.ts does not exist yet (P6). This file is
// its contract.
//
//   isolate(options)  resolves { ok: true; recreated: boolean } or { ok: false; step; reason }, and never throws.
//   teardown(options) resolves { ok: true } or { ok: false; step; reason }, and never throws.
//   step is one of 'config' | 'database' | 'port' | 'tunnel' | 'webhooks' | 'env'.
//
//   IsolateOptions = { main, worktree, ticket, seams, now, env, home, log }
//     main      the main checkout's root; the lock file lives in <main>/.work/ and siblings come from `git worktree list`
//     worktree  the worktree's project root: aspira.json is read there, and `.aspira/cloudflared.yml` is written there
//     ticket    the ticket ID ('SCOOP-7'); the name is its lower case form ('scoop-7')
//     seams     IsolationSeams = { neon, tunnel, stripe, portBusy }
//     now       () => epoch milliseconds
//     env       the process environment (STRIPE_SECRET_KEY is read from it first, then the app's env files)
//     home      the user's home directory (cloudflared keeps <home>/.cloudflared/<UUID>.json)
//     log       one call per output line; it never receives a secret
//   TeardownOptions is the same minus `now`.
//
//   Seams are built by factories, so tests run the real HTTP and argument handling against mocks:
//     neonSeam({ baseUrl, apiKey })                     Neon REST API through global fetch (Bearer apiKey)
//       GET    <baseUrl>/projects/<id>/branches          -> { branches: [{ id, name, default, parent_id?, expires_at? }] }
//       POST   <baseUrl>/projects/<id>/branches          { branch: { name, parent_id, expires_at }, endpoints: [{ type: 'read_write' }] }
//                -> { branch, endpoints, connection_uris: [{ connection_uri, connection_parameters: { host, pooler_host, ... } }] }
//                The direct string is connection_uri; the pooled one is the same string with pooler_host as the host.
//       DELETE <baseUrl>/projects/<id>/branches/<branchId>
//     tunnelSeam({ run, baseUrl, apiToken })            cloudflared through `run`, Cloudflare DNS through global fetch (Bearer apiToken)
//       cloudflared tunnel create <name>                 stdout holds the new tunnel's UUID
//       cloudflared tunnel route dns <name> <hostname>
//       cloudflared tunnel list --output json            -> [{ id, name }]
//       cloudflared tunnel delete <name>
//       GET    <baseUrl>/zones?name=<zone>               -> { result: [{ id }] }
//       GET    <baseUrl>/zones/<zoneId>/dns_records?type=CNAME&name=<hostname> -> { result: [{ id, name, content }] }
//       DELETE <baseUrl>/zones/<zoneId>/dns_records/<recordId>
//     stripeSeam({ run })                               the Stripe CLI through `run` (a rejected run is a failed step)
//       webhook_endpoints create | list [--limit n] [--starting-after id] | delete <id>
//       Every call passes { STRIPE_API_KEY } as the extra environment and never the key as an argument.
//     portBusy(port) resolves true when something listens on 127.0.0.1:<port>.
//   A `run` is (args, env) => Promise<{ status; stdout; stderr }>; a binary that cannot start reports status -1.
//
//   <worktree>/.aspira/cloudflared.yml is
//     tunnel: <uuid>
//     credentials-file: <home>/.cloudflared/<uuid>.json
//     ingress:
//       - hostname: <name>-branch.<zone>
//         path: ^/escaped/path$
//         service: http://localhost:<PORT>
//       - service: http_status:404
//   A tunnel without a webhooks entry has none. <app>/.env.development.local holds plain KEY=VALUE lines.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isolate, neonSeam, stripeSeam, teardown, tunnelSeam, type IsolateOptions, type IsolationSeams } from './isolation.js'

const NOW = Date.parse('2026-10-26T00:00:00Z')
const DAY = 86_400_000
const KEY = 'sk_test_x'
const NEON_KEY = 'neon-key'
const CF_TOKEN = 'cf-token'
const PROJECT = 'proj-1'
const ZONE_ID = 'zone-1'
const FOREIGN_UUID = 'ffffffff-0000-4000-8000-000000000000'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const tick = (): Promise<void> => new Promise((done) => setImmediate(done))

// ---------------------------------------------------------------------------------------------------------------
// The world the mocks share: what Neon, Cloudflare and Stripe hold, and everything the seams were asked.

type Branch = { id: string; name: string; default: boolean; parent_id?: string; expires_at?: string }
type Tunnel = { id: string; name: string }
type Cname = { id: string; name: string; content: string }
type Endpoint = { id: string; url: string; enabled_events: string[]; metadata: Record<string, string>; secret: string; connect: boolean }
type Request = { method: string; path: string; authorization: string | undefined; body: unknown }
type Call = { args: string[]; env: Record<string, string> }

type World = {
  branches: Branch[]
  tunnels: Tunnel[]
  cnames: Cname[]
  endpoints: Endpoint[]
  requests: Request[]
  cloudflared: string[][]
  stripe: Call[]
  probes: number[]
  busy: Set<number>
  neonCreateStatus: number
  stripeCrashAfterCreate: boolean
  cloudflaredMissing: boolean
  pageSize: number
  counter: number
}

function newWorld(): World {
  return {
    branches: [
      { id: 'br-main', name: 'main', default: true },
      { id: 'br-dev', name: 'dev', default: false, parent_id: 'br-main' },
    ],
    tunnels: [],
    cnames: [],
    endpoints: [],
    requests: [],
    cloudflared: [],
    stripe: [],
    probes: [],
    busy: new Set(),
    neonCreateStatus: 200,
    stripeCrashAfterCreate: false,
    cloudflaredMissing: false,
    pageSize: 100,
    counter: 0,
  }
}

const direct = (n: number): string => `postgresql://owner:pw${String(n)}@ep-w${String(n)}.neon.test/appdb?sslmode=require`
const pooled = (n: number): string => `postgresql://owner:pw${String(n)}@ep-w${String(n)}-pooler.neon.test/appdb?sslmode=require`

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : (JSON.parse(text) as unknown)
}

function neonRoute(world: World, request: IncomingMessage, response: ServerResponse, path: string, body: unknown): void {
  const branches = `/neon/projects/${PROJECT}/branches`
  if (request.method === 'GET' && path === branches) return json(response, 200, { branches: world.branches })
  if (request.method === 'POST' && path === branches) {
    if (world.neonCreateStatus !== 200) return json(response, world.neonCreateStatus, { message: 'upstream failure' })
    const asked = (body as { branch: { name: string; parent_id: string; expires_at: string } }).branch
    world.counter += 1
    const n = world.counter
    const branch: Branch = { id: `br-${String(n)}`, name: asked.name, default: false, parent_id: asked.parent_id, expires_at: asked.expires_at }
    world.branches.push(branch)
    return json(response, 201, {
      branch,
      endpoints: [{ id: `ep-${String(n)}`, host: `ep-w${String(n)}.neon.test`, type: 'read_write' }],
      connection_uris: [
        {
          connection_uri: direct(n),
          connection_parameters: { database: 'appdb', role: 'owner', password: `pw${String(n)}`, host: `ep-w${String(n)}.neon.test`, pooler_host: `ep-w${String(n)}-pooler.neon.test` },
        },
      ],
    })
  }
  if (request.method === 'DELETE' && path.startsWith(`${branches}/`)) {
    const id = path.slice(branches.length + 1)
    const found = world.branches.find((branch) => branch.id === id)
    if (found === undefined) return json(response, 404, { message: 'branch not found' })
    world.branches = world.branches.filter((branch) => branch.id !== id)
    return json(response, 200, { branch: found })
  }
  return json(response, 404, { message: `no route ${request.method ?? ''} ${path}` })
}

function cloudflareRoute(world: World, request: IncomingMessage, response: ServerResponse, url: URL): void {
  const path = url.pathname
  const ok = (result: unknown): void => json(response, 200, { success: true, errors: [], result })
  if (request.method === 'GET' && path === '/cf/zones') return ok([{ id: ZONE_ID, name: url.searchParams.get('name') }])
  const records = `/cf/zones/${ZONE_ID}/dns_records`
  if (request.method === 'GET' && path === records) {
    const name = url.searchParams.get('name')
    return ok(world.cnames.filter((record) => name === null || record.name === name))
  }
  if (request.method === 'DELETE' && path.startsWith(`${records}/`)) {
    const id = path.slice(records.length + 1)
    if (!world.cnames.some((record) => record.id === id)) return json(response, 404, { success: false, errors: [{ message: 'record not found' }], result: null })
    world.cnames = world.cnames.filter((record) => record.id !== id)
    return ok({ id })
  }
  return json(response, 404, { success: false, errors: [{ message: `no route ${request.method ?? ''} ${path}` }], result: null })
}

async function startMock(world: World): Promise<string> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const url = new URL(request.url ?? '/', 'http://mock')
      world.requests.push({ method: request.method ?? '', path: url.pathname, authorization: request.headers.authorization, body })
      await tick()
      if (url.pathname.startsWith('/neon/')) neonRoute(world, request, response, url.pathname, body)
      else if (url.pathname.startsWith('/cf/')) cloudflareRoute(world, request, response, url)
      else json(response, 404, { message: 'unknown' })
    })()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  )
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

type RunResult = { status: number; stdout: string; stderr: string }
const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' })
const fail = (stderr: string): RunResult => ({ status: 1, stdout: '', stderr })

/** A cloudflared that keeps its tunnels and the CNAMEs `route dns` creates in the world. */
function fakeCloudflared(world: World) {
  return async (args: readonly string[]): Promise<RunResult> => {
    world.cloudflared.push([...args])
    await tick()
    if (world.cloudflaredMissing) return { status: -1, stdout: '', stderr: 'spawn cloudflared ENOENT' }
    const positional = args.filter((arg) => !arg.startsWith('-'))
    const [, action, third, fourth, fifth] = positional
    if (action === 'list') return ok(JSON.stringify(world.tunnels))
    if (action === 'create' && third !== undefined) {
      if (world.tunnels.some((tunnel) => tunnel.name === third)) return fail(`tunnel with name ${third} already exists`)
      world.counter += 1
      const tunnel = { id: `00000000-0000-4000-8000-${String(world.counter).padStart(12, '0')}`, name: third }
      world.tunnels.push(tunnel)
      return ok(`Created tunnel ${third} with id ${tunnel.id}\n`)
    }
    if (action === 'route' && third === 'dns' && fourth !== undefined && fifth !== undefined) {
      const tunnel = world.tunnels.find((candidate) => candidate.name === fourth)
      if (tunnel === undefined) return fail(`tunnel ${fourth} not found`)
      if (world.cnames.some((record) => record.name === fifth)) return fail(`record ${fifth} already exists`)
      world.counter += 1
      world.cnames.push({ id: `dns-${String(world.counter)}`, name: fifth, content: `${tunnel.id}.cfargotunnel.com` })
      return ok(`Added CNAME ${fifth} which will route to this tunnel\n`)
    }
    if (action === 'delete' && third !== undefined) {
      if (!world.tunnels.some((tunnel) => tunnel.name === third)) return fail(`tunnel ${third} not found`)
      world.tunnels = world.tunnels.filter((tunnel) => tunnel.name !== third)
      return ok(`Deleted tunnel ${third}\n`)
    }
    return fail(`unsupported cloudflared command ${args.join(' ')}`)
  }
}

type StripeParams = { flags: Map<string, string[]>; data: Array<[string, string]> }

/** The Stripe CLI's grammar: `--flag value`, `--flag=value` and `-d key=value`, flags with `_` and `-` alike. */
function stripeParams(args: readonly string[]): StripeParams {
  const flags = new Map<string, string[]>()
  const data: Array<[string, string]> = []
  const add = (name: string, value: string): void => {
    const key = name.replaceAll('_', '-')
    flags.set(key, [...(flags.get(key) ?? []), value])
  }
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-d' || arg === '--data') {
      const pair = args[index + 1] ?? ''
      index += 1
      const eq = pair.indexOf('=')
      data.push([pair.slice(0, eq), pair.slice(eq + 1)])
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) add(arg.slice(2, eq), arg.slice(eq + 1))
      else if (args[index + 1] !== undefined && !(args[index + 1] ?? '').startsWith('-')) {
        add(arg.slice(2), args[index + 1] ?? '')
        index += 1
      } else add(arg.slice(2), 'true')
    }
  }
  return { flags, data }
}

type Described = { url: string | undefined; events: string[]; metadata: Record<string, string>; connect: boolean }

function describeCreate(args: readonly string[]): Described {
  const { flags, data } = stripeParams(args)
  const fromData = (name: string): string | undefined => data.find(([key]) => key === name)?.[1]
  const events = [...(flags.get('enabled-events') ?? []).flatMap((value) => value.split(',')), ...data.filter(([key]) => /^enabled_events(\[\d*\])?$/.test(key)).map(([, value]) => value)]
  const metadata: Record<string, string> = {}
  for (const [key, value] of data) {
    const match = /^metadata\[(.+)\]$/.exec(key)
    if (match?.[1] !== undefined) metadata[match[1]] = value
  }
  for (const [name, values] of flags) {
    const match = /^metadata\[(.+)\]$/.exec(name)
    if (match?.[1] !== undefined) metadata[match[1]] = values[0] ?? ''
    if (name === 'metadata') {
      for (const pair of values) {
        const eq = pair.indexOf('=')
        metadata[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
    }
  }
  const connectFlag = flags.get('connect')?.[0] ?? fromData('connect')
  return { url: flags.get('url')?.[0] ?? fromData('url'), events, metadata, connect: connectFlag !== undefined && connectFlag !== 'false' }
}

const publicEndpoint = ({ secret: _secret, ...rest }: Endpoint): Omit<Endpoint, 'secret'> => rest

/** A Stripe CLI over the world's endpoints: list pages by `--starting-after`, `delete` takes the endpoint id. */
function fakeStripe(world: World) {
  return async (args: readonly string[], env: Readonly<Record<string, string>>): Promise<RunResult> => {
    world.stripe.push({ args: [...args], env: { ...env } })
    await tick()
    if (env.STRIPE_API_KEY === undefined) return fail('no API key')
    if (args[0] !== 'webhook_endpoints') return fail(`unsupported stripe command ${args.join(' ')}`)
    if (args[1] === 'create') {
      const described = describeCreate(args)
      world.counter += 1
      const endpoint: Endpoint = {
        id: `we_${String(world.counter)}`,
        url: described.url ?? '',
        enabled_events: described.events,
        metadata: described.metadata,
        secret: `whsec_${String(world.counter)}`,
        connect: described.connect,
      }
      world.endpoints.push(endpoint)
      if (world.stripeCrashAfterCreate) throw new Error('run aborted after the endpoint was created')
      return ok(JSON.stringify({ object: 'webhook_endpoint', ...endpoint }))
    }
    if (args[1] === 'list') {
      const { flags } = stripeParams(args)
      const limit = Math.min(Number(flags.get('limit')?.[0] ?? '10'), world.pageSize)
      const after = flags.get('starting-after')?.[0]
      const start = after === undefined ? 0 : world.endpoints.findIndex((endpoint) => endpoint.id === after) + 1
      const page = world.endpoints.slice(start, start + limit)
      return ok(JSON.stringify({ object: 'list', data: page.map(publicEndpoint), has_more: start + limit < world.endpoints.length }))
    }
    if (args[1] === 'delete') {
      const id = args[2] ?? ''
      if (!world.endpoints.some((endpoint) => endpoint.id === id)) return fail(`No such webhook endpoint: ${id}`)
      world.endpoints = world.endpoints.filter((endpoint) => endpoint.id !== id)
      return ok(JSON.stringify({ id, object: 'webhook_endpoint', deleted: true }))
    }
    return fail(`unsupported stripe command ${args.join(' ')}`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Temp git repositories.

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

type Fx = { tmp: string; main: string; home: string }

const IGNORE = ['.env.development.local', '.env.local', '.aspira/', '.work/', '.worktrees/']

function fixture(ignore: readonly string[] = IGNORE): Fx {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ai-isolation-')))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
  const main = join(tmp, 'repo')
  const home = join(tmp, 'home')
  mkdirSync(main)
  mkdirSync(home)
  sh(main, 'init', '-q', '-b', 'main')
  writeFileSync(join(main, '.gitignore'), `${ignore.join('\n')}\n`)
  mkdirSync(join(main, 'web'))
  writeFileSync(join(main, 'web', 'package.json'), '{"name":"web","private":true}\n')
  sh(main, 'add', '-A')
  sh(main, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'initial')
  return { tmp, main, home }
}

function addWorktree(fx: Fx, ticket: string, config?: Record<string, unknown>): string {
  const path = join(fx.main, '.worktrees', `FEATURE-${ticket}`)
  sh(fx.main, 'worktree', 'add', '-q', '-b', `feat/${ticket.toLowerCase()}-x`, path)
  if (config !== undefined) writeFileSync(join(path, 'aspira.json'), JSON.stringify(config))
  return path
}

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

// ---------------------------------------------------------------------------------------------------------------
// Config and harness.

const DATABASE = { provider: 'neon', projectId: PROJECT, parentBranch: 'dev', envVars: ['DATABASE_URL', { name: 'DIRECT_URL', pooled: false }] }
const STRIPE_HOOK = { provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed', 'invoice.paid'], connect: false }
const DEV_URL = { command: 'pnpm dev', cwd: 'web', url: 'http://{name}.localhost:{port}' }

const config = (extra: Record<string, unknown>): Record<string, unknown> => ({ board: 'https://www.notion.so/board', app: 'web', tunnel: { zone: 'aspiralabs.co' }, ...extra })

type Harness = { fx: Fx; world: World; seams: IsolationSeams; wt: string; app: string; envFile: string; lines: string[]; env: Record<string, string | undefined> }

async function harness(settings: Record<string, unknown>, options: { ignore?: readonly string[]; env?: Record<string, string | undefined> } = {}): Promise<Harness> {
  const fx = fixture(options.ignore)
  const world = newWorld()
  const base = await startMock(world)
  const seams: IsolationSeams = {
    neon: neonSeam({ baseUrl: `${base}/neon`, apiKey: NEON_KEY }),
    tunnel: tunnelSeam({ run: fakeCloudflared(world), baseUrl: `${base}/cf`, apiToken: CF_TOKEN }),
    stripe: stripeSeam({ run: fakeStripe(world) }),
    portBusy: async (port: number) => {
      world.probes.push(port)
      await tick()
      return world.busy.has(port)
    },
  }
  const wt = addWorktree(fx, 'SCOOP-7', config(settings))
  const app = join(wt, 'web')
  return { fx, world, seams, wt, app, envFile: join(app, '.env.development.local'), lines: [], env: options.env ?? { STRIPE_SECRET_KEY: KEY } }
}

function go(h: Harness, over: Partial<IsolateOptions> = {}) {
  return isolate({ main: h.fx.main, worktree: h.wt, ticket: 'SCOOP-7', seams: h.seams, now: () => NOW, env: h.env, home: h.fx.home, log: (line) => h.lines.push(line), ...over })
}

function tear(h: Harness) {
  return teardown({ main: h.fx.main, worktree: h.wt, ticket: 'SCOOP-7', seams: h.seams, env: h.env, home: h.fx.home, log: (line) => h.lines.push(line) })
}

/** A further worktree of the same repository with its own aspira.json. */
function another(h: Harness, ticket: string, settings: Record<string, unknown>): string {
  return addWorktree(h.fx, ticket, config(settings))
}

const neonCreates = (world: World): Request[] => world.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/branches'))
const positional = (args: readonly string[]): string => args.filter((arg) => !arg.startsWith('-')).join(' ')
const cloudflaredCommands = (world: World): string[] => world.cloudflared.map(positional)
const stripeCreates = (world: World): Call[] => world.stripe.filter((call) => call.args[0] === 'webhook_endpoints' && call.args[1] === 'create')
const stripeDeletes = (world: World): Call[] => world.stripe.filter((call) => call.args[0] === 'webhook_endpoints' && call.args[1] === 'delete')
const tagged = (world: World, name: string): Endpoint[] => world.endpoints.filter((endpoint) => endpoint.metadata.aspira_worktree === name)

function snapshot(world: World): string {
  return JSON.stringify({
    branches: world.branches.map((branch) => branch.name).toSorted(),
    tunnels: world.tunnels.map((tunnel) => tunnel.name).toSorted(),
    cnames: world.cnames.map((record) => `${record.name}>${record.content}`).toSorted(),
    endpoints: world.endpoints.map((endpoint) => endpoint.id).toSorted(),
  })
}

type Rule = Record<string, string>

function ingressRules(yml: string): Rule[] {
  const rules: Rule[] = []
  let inIngress = false
  let current: Rule | undefined
  for (const raw of yml.split('\n')) {
    if (/^ingress:\s*$/.test(raw)) {
      inIngress = true
      continue
    }
    if (!inIngress) continue
    if (/^\S/.test(raw)) break
    const match = /^\s*(-\s+)?([A-Za-z-]+):\s*(.*)$/.exec(raw)
    if (match?.[2] === undefined) continue
    if (match[1] !== undefined) {
      current = {}
      rules.push(current)
    }
    const value = (match[3] ?? '').trim()
    if (current !== undefined) current[match[2]] = value.startsWith('"') ? (JSON.parse(value) as string) : value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value
  }
  return rules
}

const ymlOf = (h: Harness): string => readFileSync(join(h.wt, '.aspira', 'cloudflared.yml'), 'utf8')

// ---------------------------------------------------------------------------------------------------------------

describe('isolate: the database (F2, F3)', () => {
  it('T7 creates wt/scoop-7 from dev with one read_write endpoint and a 14 day expiry, and writes both connection strings', async () => {
    const h = await harness({ database: DATABASE })
    const result = await go(h)
    expect(result.ok).toBe(true)
    const creates = neonCreates(h.world)
    expect(creates).toHaveLength(1)
    const body = creates[0]!.body as { branch: { name: string; parent_id: string; expires_at: string }; endpoints: Array<{ type: string }> }
    expect(creates[0]!.authorization).toBe(`Bearer ${NEON_KEY}`)
    expect(body.branch.name).toBe('wt/scoop-7')
    expect(body.branch.parent_id).toBe('br-dev')
    expect(body.endpoints).toEqual([{ type: 'read_write' }])
    expect(Date.parse(body.branch.expires_at)).toBe(NOW + 14 * DAY)
    const env = readEnv(h.envFile)
    expect(env.DATABASE_URL).toBe(pooled(1))
    expect(env.DIRECT_URL).toBe(direct(1))
  })

  it('T8 refuses a parentBranch that is the default branch: the database step fails and nothing is created or written', async () => {
    const h = await harness({ database: { ...DATABASE, parentBranch: 'main' } })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.step).toBe('database')
    expect(result.reason).toMatch(/default/i)
    expect(neonCreates(h.world)).toHaveLength(0)
    expect(existsSync(h.envFile)).toBe(false)
  })
})

describe('isolate: a rerun (F4)', () => {
  it('T9 creates nothing on a second run, then recreates an expired branch with new strings and says so', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK], dev: DEV_URL })
    expect((await go(h)).ok).toBe(true)
    const first = readFileSync(h.envFile, 'utf8')
    const firstEnv = readEnv(h.envFile)
    expect(neonCreates(h.world)).toHaveLength(1)
    expect(cloudflaredCommands(h.world).filter((command) => command.startsWith('tunnel create'))).toHaveLength(1)
    expect(stripeCreates(h.world)).toHaveLength(1)

    h.lines.length = 0
    const second = await go(h)
    expect(second.ok).toBe(true)
    expect(neonCreates(h.world)).toHaveLength(1)
    expect(cloudflaredCommands(h.world).filter((command) => command.startsWith('tunnel create'))).toHaveLength(1)
    expect(cloudflaredCommands(h.world).filter((command) => command.startsWith('tunnel route'))).toHaveLength(1)
    expect(stripeCreates(h.world)).toHaveLength(1)
    expect(readFileSync(h.envFile, 'utf8')).toBe(first)

    h.world.branches = h.world.branches.filter((branch) => branch.name !== 'wt/scoop-7')
    h.lines.length = 0
    const third = await go(h)
    expect(third.ok).toBe(true)
    const creates = neonCreates(h.world)
    expect(creates).toHaveLength(2)
    expect((creates[1]!.body as { branch: { name: string; parent_id: string } }).branch).toMatchObject({ name: 'wt/scoop-7', parent_id: 'br-dev' })
    const env = readEnv(h.envFile)
    expect(env.DATABASE_URL).not.toBe(firstEnv.DATABASE_URL)
    expect(env.DATABASE_URL).toBe(pooled(h.world.counter))
    expect(env.DIRECT_URL).toBe(direct(h.world.counter))
    expect(env.PORT).toBe(firstEnv.PORT)
    expect(env.BETTER_AUTH_URL).toBe(firstEnv.BETTER_AUTH_URL)
    expect(env.STRIPE_WEBHOOK_SECRET).toBe(firstEnv.STRIPE_WEBHOOK_SECRET)
    expect(stripeCreates(h.world)).toHaveLength(1)
    const said = h.lines.join('\n')
    expect(said).toMatch(/recreated/i)
    expect(said).toMatch(/migrations/i)
    expect(said).toContain('kit db migrate')
  })
})

describe('isolate: a failing step (F5)', () => {
  it('T10 case A: a Neon 500 fails the database step, and a healthy rerun completes', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    h.world.neonCreateStatus = 500
    const failed = await go(h)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.step).toBe('database')
    h.world.neonCreateStatus = 200
    const rerun = await go(h)
    expect(rerun.ok).toBe(true)
    expect(h.world.branches.some((branch) => branch.name === 'wt/scoop-7')).toBe(true)
    expect(h.world.tunnels.map((tunnel) => tunnel.name)).toEqual(['wt-scoop-7'])
    expect(tagged(h.world, 'scoop-7')).toHaveLength(1)
  })

  it('T10 case B: a run aborted after Stripe created the endpoint fails the webhooks step; the rerun replaces that endpoint and ends with its secret', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    h.world.stripeCrashAfterCreate = true
    const failed = await go(h)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.step).toBe('webhooks')
    expect(h.world.branches.some((branch) => branch.name === 'wt/scoop-7')).toBe(true)
    expect(h.world.tunnels).toHaveLength(1)
    const orphan = h.world.endpoints[0]!
    expect(readEnv(h.envFile).STRIPE_WEBHOOK_SECRET).toBeUndefined()

    h.world.stripeCrashAfterCreate = false
    const rerun = await go(h)
    expect(rerun.ok).toBe(true)
    expect(stripeDeletes(h.world).map((call) => call.args[2])).toEqual([orphan.id])
    const live = tagged(h.world, 'scoop-7')
    expect(live).toHaveLength(1)
    expect(live[0]!.id).not.toBe(orphan.id)
    expect(readEnv(h.envFile).STRIPE_WEBHOOK_SECRET).toBe(live[0]!.secret)
    expect(neonCreates(h.world)).toHaveLength(1)
  })

  it('T10 case C: cloudflared missing fails the tunnel step and keeps the branch; a healthy rerun completes without a second branch', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    h.world.cloudflaredMissing = true
    const failed = await go(h)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.step).toBe('tunnel')
    expect(h.world.branches.some((branch) => branch.name === 'wt/scoop-7')).toBe(true)
    expect(readEnv(h.envFile).DATABASE_URL).toBe(pooled(1))

    h.world.cloudflaredMissing = false
    const rerun = await go(h)
    expect(rerun.ok).toBe(true)
    expect(neonCreates(h.world)).toHaveLength(1)
    expect(h.world.tunnels.map((tunnel) => tunnel.name)).toEqual(['wt-scoop-7'])
    expect(tagged(h.world, 'scoop-7')).toHaveLength(1)
  })
})

describe('isolate: the git-ignore refusal (F6)', () => {
  it('T11 case A: an unignored .env.development.local fails naming the line and is not written', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] }, { ignore: ['.aspira/', '.work/', '.worktrees/'] })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('.env.development.local')
    expect(existsSync(h.envFile)).toBe(false)
  })

  it('T11 case B: an unignored .aspira/ fails naming the line and cloudflared.yml is not written', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] }, { ignore: ['.env.development.local', '.work/', '.worktrees/'] })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('.aspira/')
    expect(existsSync(join(h.wt, '.aspira', 'cloudflared.yml'))).toBe(false)
  })

  it('T38 an unignored .aspira/ tells the engineer to run kit update, never to add .aspira/ to .gitignore', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] }, { ignore: ['.env.development.local', '.work/', '.worktrees/'] })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.step).toBe('tunnel')
    expect(result.reason).toContain('kit update')
    expect(result.reason).not.toContain('kit init')
    expect(result.reason).not.toMatch(/add the line \.aspira\/ to \.gitignore/)
  })
})

describe('isolate: the port (F9)', () => {
  function siblings(h: Harness): void {
    for (const [ticket, port] of [
      ['KIT-1', 3001],
      ['KIT-2', 3003],
    ] as const) {
      const sibling = addWorktree(h.fx, ticket)
      writeFileSync(join(sibling, 'web', '.env.development.local'), `PORT=${String(port)}\n`)
    }
    h.world.busy.add(3002)
  }

  it('T12 gives a new worktree the lowest port no sibling claims and nothing listens on', async () => {
    const h = await harness({ dev: DEV_URL })
    siblings(h)
    const result = await go(h)
    expect(result.ok).toBe(true)
    expect(readEnv(h.envFile).PORT).toBe('3004')
  })

  it('T12 gives two setups at once for different tickets two different free ports', async () => {
    const h = await harness({ dev: DEV_URL })
    siblings(h)
    const eight = another(h, 'SCOOP-8', { dev: DEV_URL })
    const nine = another(h, 'SCOOP-9', { dev: DEV_URL })
    const results = await Promise.all([go(h, { worktree: eight, ticket: 'SCOOP-8' }), go(h, { worktree: nine, ticket: 'SCOOP-9' })])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    const ports = [eight, nine].map((path) => readEnv(join(path, 'web', '.env.development.local')).PORT)
    expect(ports.toSorted()).toEqual(['3004', '3005'])
  })
})

describe('isolate: the app URL (F10)', () => {
  it('T13 case A writes the default URL variables and ASPIRA_WORKTREE', async () => {
    const h = await harness({ database: DATABASE, dev: DEV_URL })
    expect((await go(h)).ok).toBe(true)
    const env = readEnv(h.envFile)
    const url = `http://scoop-7.localhost:${env.PORT ?? ''}`
    expect(env.PORT).toMatch(/^\d+$/)
    expect(env.BETTER_AUTH_URL).toBe(url)
    expect(env.NEXT_PUBLIC_APP_URL).toBe(url)
    expect(env.ASPIRA_WORKTREE).toBe('scoop-7')
  })

  it('T13 case B writes only the variables dev.urlEnvVars lists', async () => {
    const h = await harness({ database: DATABASE, dev: { ...DEV_URL, urlEnvVars: ['APP_URL'] } })
    expect((await go(h)).ok).toBe(true)
    const env = readEnv(h.envFile)
    expect(env.APP_URL).toBe(`http://scoop-7.localhost:${env.PORT ?? ''}`)
    expect(env.BETTER_AUTH_URL).toBeUndefined()
    expect(env.NEXT_PUBLIC_APP_URL).toBeUndefined()
    expect(env.ASPIRA_WORKTREE).toBe('scoop-7')
  })
})

describe('isolate: the tunnel (F14, F15)', () => {
  it('T14 creates tunnel wt-scoop-7 and routes scoop-7-branch.aspiralabs.co to it', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    expect((await go(h)).ok).toBe(true)
    const commands = cloudflaredCommands(h.world)
    expect(commands).toContain('tunnel create wt-scoop-7')
    expect(commands).toContain('tunnel route dns wt-scoop-7 scoop-7-branch.aspiralabs.co')
  })

  it('T15 writes one anchored rule per path forwarding to the port, then a pathless 404', async () => {
    const h = await harness({
      webhooks: [STRIPE_HOOK, { ...STRIPE_HOOK, path: '/api/webhooks/connect', secretEnvVar: 'STRIPE_CONNECT_PATH_SECRET' }],
    })
    expect((await go(h)).ok).toBe(true)
    const port = readEnv(h.envFile).PORT ?? ''
    const rules = ingressRules(ymlOf(h))
    const last = rules.at(-1)!
    expect(last.service).toBe('http_status:404')
    expect(last.path).toBeUndefined()
    const forwarding = rules.slice(0, -1)
    expect(forwarding).toHaveLength(2)
    for (const rule of forwarding) {
      expect(rule.path).toMatch(/^\^.*\$$/)
      expect(rule.service).toMatch(new RegExp(`localhost:${port}$`))
    }
    const matching = (path: string): Rule[] => forwarding.filter((rule) => new RegExp(rule.path!).test(path))
    expect(matching('/api/webhooks/stripe')).toHaveLength(1)
    expect(matching('/api/webhooks/connect')).toHaveLength(1)
    expect(matching('/api/webhooks/stripe')[0]).not.toBe(matching('/api/webhooks/connect')[0])
    for (const path of ['/x/api/webhooks/stripe', '/api/webhooks/stripex', '/api/webhooks/stripe/../admin', '/api/webhooks/stripe/%2e%2e/admin', '/', '/admin']) {
      expect(matching(path)).toEqual([])
    }
  })

  it('T15 refuses a webhook path that does not start with / and creates nothing', async () => {
    const h = await harness({ database: DATABASE, webhooks: [{ ...STRIPE_HOOK, path: 'api/webhooks/stripe' }] })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('api/webhooks/stripe')
    expect(stripeCreates(h.world)).toHaveLength(0)
    expect(existsSync(join(h.wt, '.aspira', 'cloudflared.yml'))).toBe(false)
  })
})

describe('isolate: the Stripe endpoints (F16-F20)', () => {
  it('T16 case A creates the account endpoint with its events and tag, and writes its secret', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    expect((await go(h)).ok).toBe(true)
    const creates = stripeCreates(h.world)
    expect(creates).toHaveLength(1)
    const described = describeCreate(creates[0]!.args)
    expect(described.url).toBe('https://scoop-7-branch.aspiralabs.co/api/webhooks/stripe')
    expect(described.events).toEqual(['checkout.session.completed', 'invoice.paid'])
    expect(described.metadata).toEqual({ aspira_worktree: 'scoop-7' })
    expect(described.connect).toBe(false)
    expect(readEnv(h.envFile).STRIPE_WEBHOOK_SECRET).toBe(h.world.endpoints[0]!.secret)
  })

  it('T16 case B also creates a tagged Connect endpoint and writes each secret under its configured name', async () => {
    const h = await harness({ database: DATABASE, webhooks: [{ ...STRIPE_HOOK, connect: true, secretEnvVar: 'MY_STRIPE_SECRET', connectSecretEnvVar: 'MY_CONNECT_SECRET' }] })
    expect((await go(h)).ok).toBe(true)
    const described = stripeCreates(h.world).map((call) => describeCreate(call.args))
    expect(described).toHaveLength(2)
    const account = described.find((entry) => !entry.connect)!
    const connect = described.find((entry) => entry.connect)!
    expect(account.metadata).toEqual({ aspira_worktree: 'scoop-7' })
    expect(connect.metadata).toEqual({ aspira_worktree: 'scoop-7', aspira_kind: 'connect' })
    expect(connect.url).toBe('https://scoop-7-branch.aspiralabs.co/api/webhooks/stripe')
    const env = readEnv(h.envFile)
    expect(env.MY_STRIPE_SECRET).toBe(h.world.endpoints.find((endpoint) => !endpoint.connect)!.secret)
    expect(env.MY_CONNECT_SECRET).toBe(h.world.endpoints.find((endpoint) => endpoint.connect)!.secret)
  })

  it('T17 passes STRIPE_SECRET_KEY from the app .env.local as STRIPE_API_KEY, never as an argument or in the log', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] }, { env: {} })
    writeFileSync(join(h.app, '.env.local'), `STRIPE_SECRET_KEY=${KEY}\n`)
    const result = await go(h)
    expect(result.ok).toBe(true)
    expect(h.world.stripe.length).toBeGreaterThan(0)
    for (const call of h.world.stripe) {
      expect(call.env.STRIPE_API_KEY).toBe(KEY)
      expect(call.args.join(' ')).not.toContain(KEY)
      expect(call.args).not.toContain('switch')
    }
    expect(h.lines.join('\n')).not.toContain(KEY)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('T17 refuses an sk_live_ key and sends no create', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] }, { env: {} })
    writeFileSync(join(h.app, '.env.local'), 'STRIPE_SECRET_KEY=sk_live_x\n')
    const result = await go(h)
    expect(result.ok).toBe(false)
    expect(stripeCreates(h.world)).toHaveLength(0)
    expect(h.lines.join('\n')).not.toContain('sk_live_x')
    expect(JSON.stringify(result)).not.toContain('sk_live_x')
  })

  it('T18 counts endpoints on every page and fails naming the limit and the count when a create would pass 16', async () => {
    const h = await harness({ webhooks: [STRIPE_HOOK] })
    h.world.pageSize = 10
    for (let index = 0; index < 16; index += 1) {
      h.world.endpoints.push({ id: `we_old${String(index)}`, url: `https://old${String(index)}.example.test/hook`, enabled_events: ['*'], metadata: {}, secret: 'x', connect: false })
    }
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/limit/i)
    expect(result.reason.match(/\b16\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(stripeCreates(h.world)).toHaveLength(0)
    expect(h.world.stripe.some((call) => call.args.includes('--starting-after') || call.args.some((arg) => arg.startsWith('--starting-after=')))).toBe(true)
  })

  it('T19 refuses a provider other than stripe before calling any seam', async () => {
    const h = await harness({ database: DATABASE, webhooks: [{ ...STRIPE_HOOK, provider: 'resend' }] })
    const result = await go(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/stripe only/i)
    expect(h.world.requests).toEqual([])
    expect(h.world.cloudflared).toEqual([])
    expect(h.world.stripe).toEqual([])
    expect(h.world.probes).toEqual([])
  })
})

describe('teardown (F22, F23)', () => {
  it('T20 deletes only what the kit marked and reports a CNAME it does not own', async () => {
    const h = await harness({ database: DATABASE, webhooks: [{ ...STRIPE_HOOK, connect: true }] })
    expect((await go(h)).ok).toBe(true)
    const own = h.world.tunnels.find((tunnel) => tunnel.name === 'wt-scoop-7')!
    h.world.branches.push({ id: 'br-foreign', name: 'scoop-7', default: false, parent_id: 'br-dev' })
    h.world.tunnels.push({ id: FOREIGN_UUID, name: 'scoop-7' })
    h.world.cnames.push({ id: 'dns-foreign', name: 'scoop-7-branch.aspiralabs.co', content: `${FOREIGN_UUID}.cfargotunnel.com` })
    h.world.endpoints.push(
      { id: 'we_untagged', url: 'https://scoop-7-branch.aspiralabs.co/api/webhooks/stripe', enabled_events: ['*'], metadata: {}, secret: 'x', connect: false },
      { id: 'we_other', url: 'https://scoop-8-branch.aspiralabs.co/api/webhooks/stripe', enabled_events: ['*'], metadata: { aspira_worktree: 'scoop-8' }, secret: 'x', connect: false },
    )
    h.lines.length = 0
    const result = await tear(h)
    expect(result.ok).toBe(true)
    expect(h.world.branches.map((branch) => branch.name).toSorted()).toEqual(['dev', 'main', 'scoop-7'])
    expect(h.world.tunnels.map((tunnel) => tunnel.name)).toEqual(['scoop-7'])
    expect(h.world.cnames).toEqual([{ id: 'dns-foreign', name: 'scoop-7-branch.aspiralabs.co', content: `${FOREIGN_UUID}.cfargotunnel.com` }])
    expect(h.world.endpoints.map((endpoint) => endpoint.id).toSorted()).toEqual(['we_other', 'we_untagged'])
    expect(h.world.cnames.some((record) => record.content.startsWith(own.id))).toBe(false)
    expect(h.lines.join('\n')).toContain(FOREIGN_UUID)
  })

  it('T21 case A succeeds with nothing left to delete', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    const result = await tear(h)
    expect(result.ok).toBe(true)
    expect(h.world.branches.map((branch) => branch.name).toSorted()).toEqual(['dev', 'main'])
  })

  it('T21 case B deletes a CNAME left behind by a deleted tunnel, using the UUID in cloudflared.yml, and a second run changes nothing', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    expect((await go(h)).ok).toBe(true)
    h.world.tunnels = []
    expect(h.world.cnames).toHaveLength(1)
    expect((await tear(h)).ok).toBe(true)
    expect(h.world.cnames).toEqual([])
    const after = snapshot(h.world)
    expect((await tear(h)).ok).toBe(true)
    expect(snapshot(h.world)).toBe(after)
  })

  it('T21 case C deletes a tunnel whose CNAME is gone, and a second run changes nothing', async () => {
    const h = await harness({ database: DATABASE, webhooks: [STRIPE_HOOK] })
    expect((await go(h)).ok).toBe(true)
    h.world.cnames = []
    expect((await tear(h)).ok).toBe(true)
    expect(h.world.tunnels).toEqual([])
    const after = snapshot(h.world)
    expect((await tear(h)).ok).toBe(true)
    expect(snapshot(h.world)).toBe(after)
  })
})

describe('isolate: two runs at once (F31)', () => {
  it('T22 leaves exactly one branch, one tunnel, one account endpoint and one Connect endpoint for the ticket', async () => {
    const h = await harness({ database: DATABASE, webhooks: [{ ...STRIPE_HOOK, connect: true }] })
    const results = await Promise.all([go(h), go(h)])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(h.world.branches.filter((branch) => branch.name === 'wt/scoop-7')).toHaveLength(1)
    expect(h.world.tunnels.filter((tunnel) => tunnel.name === 'wt-scoop-7')).toHaveLength(1)
    const endpoints = tagged(h.world, 'scoop-7')
    expect(endpoints.filter((endpoint) => !endpoint.connect)).toHaveLength(1)
    expect(endpoints.filter((endpoint) => endpoint.connect)).toHaveLength(1)
    expect(h.world.endpoints).toHaveLength(2)
  })
})

describe('no new dependency (F29)', () => {
  it('T37 adds no neon, stripe or cloudflare package to packages/ai or the root manifest', () => {
    const manifests = [new URL('../package.json', import.meta.url), new URL('../../../package.json', import.meta.url)]
    const names = manifests.flatMap((url) => {
      const manifest = JSON.parse(readFileSync(url, 'utf8')) as Record<string, Record<string, string> | undefined>
      return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}))
    })
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => /neon|stripe|cloudflare/i.test(name))).toEqual([])
  })
})
