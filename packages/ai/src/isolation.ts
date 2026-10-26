// The one isolation module (KIT-67, spec decision Q3). `isolate` brings a ticket's worktree to its own state
// step by step: a Neon branch, a port and app URL, a Cloudflare tunnel, Stripe webhook endpoints, and the
// `.env.development.local` that holds the results. `teardown` removes only what the kit marked. Both run under an
// exclusive lock file in the main checkout's `.work/`, create only what is missing, and never throw: a failed step
// is returned by name (Q5), what earlier steps made is kept, and a rerun resumes.
//
// The services sit behind seams (Q18). Neon and Cloudflare DNS go through global `fetch` with an overridable base
// URL; `cloudflared` and the Stripe CLI go through injected process runners. Every seam has a factory here, and
// `defaultSeams` builds the live set from the environment (NEON_API_BASE_URL and CLOUDFLARE_API_BASE_URL override
// the two base URLs, which is how the driver's tests reach their mocks across a process boundary).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, closeSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { appRoot, readAspira } from './aspira.js'
import type { Log } from './fs.js'
import { isGitIgnored, listWorktrees } from './git.js'

export type IsolationStep = 'config' | 'database' | 'port' | 'tunnel' | 'webhooks' | 'env'
export type IsolateResult = { ok: true; recreated: boolean } | { ok: false; step: IsolationStep; reason: string }
export type TeardownResult = { ok: true } | { ok: false; step: IsolationStep; reason: string }

// ---------------------------------------------------------------------------------------------------------------
// Seams.

export type RunResult = { status: number; stdout: string; stderr: string }
/** Runs one binary; `env` is added to the process environment. A binary that cannot start reports status -1. */
export type Run = (args: readonly string[], env: Readonly<Record<string, string>>) => Promise<RunResult>

export type NeonBranch = { id: string; name: string; default: boolean; parentId?: string; expiresAt?: string }
export type NeonSeam = {
  listBranches: (projectId: string) => Promise<NeonBranch[]>
  createBranch: (projectId: string, spec: { name: string; parentId: string; expiresAt: string }) => Promise<{ id: string; pooled: string; direct: string }>
  deleteBranch: (projectId: string, branchId: string) => Promise<void>
}
export type Cname = { id: string; name: string; content: string }
export type TunnelSeam = {
  listTunnels: () => Promise<Array<{ id: string; name: string }>>
  /** Creates the named tunnel and returns its UUID. */
  createTunnel: (name: string) => Promise<string>
  routeDns: (tunnel: string, hostname: string) => Promise<void>
  deleteTunnel: (name: string) => Promise<void>
  listCnames: (zone: string, hostname: string) => Promise<Cname[]>
  deleteCname: (zone: string, recordId: string) => Promise<void>
}
export type StripeEndpoint = { id: string; url: string; metadata: Record<string, string> }
export type StripeSeam = {
  /** Every endpoint of the account, all pages. */
  listEndpoints: (apiKey: string) => Promise<StripeEndpoint[]>
  createEndpoint: (apiKey: string, spec: { url: string; events: readonly string[]; metadata: Readonly<Record<string, string>>; connect: boolean }) => Promise<{ id: string; secret: string }>
  deleteEndpoint: (apiKey: string, id: string) => Promise<void>
}
export type IsolationSeams = { neon: NeonSeam; tunnel: TunnelSeam; stripe: StripeSeam; portBusy: (port: number) => Promise<boolean> }

const NEON_BASE = 'https://console.neon.tech/api/v2'
const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4'

const Json = z.looseObject({})

async function call(service: string, method: string, url: string, token: string | undefined, tokenName: string, body?: unknown): Promise<unknown> {
  if (token === undefined || token === '') throw new Error(`${tokenName} is not set`)
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const asObject = Json.safeParse(parsed)
  const object = asObject.success ? asObject.data : {}
  const first = Array.isArray(object.errors) ? z.looseObject({ message: z.string().optional() }).safeParse(object.errors[0]) : undefined
  const message = typeof object.message === 'string' ? object.message : first?.success === true ? first.data.message : undefined
  if (!response.ok || object.success === false) {
    throw new Error(`${service} ${method} ${new URL(url).pathname} answered ${String(response.status)}${message === undefined ? '' : `: ${message}`}`)
  }
  return parsed
}

const NeonBranchList = z.object({
  branches: z.array(z.looseObject({ id: z.string(), name: z.string(), default: z.boolean().optional(), primary: z.boolean().optional(), parent_id: z.string().nullish(), expires_at: z.string().nullish() })),
})
const NeonCreated = z.object({
  branch: z.looseObject({ id: z.string() }),
  connection_uris: z.array(z.looseObject({ connection_uri: z.string(), connection_parameters: z.looseObject({ host: z.string().optional(), pooler_host: z.string().optional() }).optional() })).optional(),
})

/** The same connection string with its host replaced. */
function withHost(uri: string, host: string): string {
  return uri.replace(/^([a-z][a-z0-9+.-]*:\/\/[^@/]*@)[^/:?]+/i, (_all, head: string) => `${head}${host}`)
}

/** The Neon REST API through global fetch (Bearer `apiKey`). */
export function neonSeam(options: { baseUrl?: string | undefined; apiKey: string | undefined }): NeonSeam {
  const base = (options.baseUrl ?? NEON_BASE).replace(/\/+$/, '')
  const request = (method: string, path: string, body?: unknown): Promise<unknown> => call('Neon', method, `${base}${path}`, options.apiKey, 'NEON_API_KEY', body)
  return {
    async listBranches(projectId) {
      const list = NeonBranchList.parse(await request('GET', `/projects/${encodeURIComponent(projectId)}/branches?limit=1000`))
      return list.branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        default: branch.default === true || branch.primary === true,
        ...(branch.parent_id == null ? {} : { parentId: branch.parent_id }),
        ...(branch.expires_at == null ? {} : { expiresAt: branch.expires_at }),
      }))
    },
    async createBranch(projectId, spec) {
      const created = NeonCreated.parse(
        await request('POST', `/projects/${encodeURIComponent(projectId)}/branches`, {
          branch: { name: spec.name, parent_id: spec.parentId, expires_at: spec.expiresAt },
          endpoints: [{ type: 'read_write' }],
        }),
      )
      const uri = created.connection_uris?.[0]
      if (uri === undefined) throw new Error(`Neon created ${spec.name} but returned no connection string`)
      const host = uri.connection_parameters?.host
      const poolerHost = uri.connection_parameters?.pooler_host
      return {
        id: created.branch.id,
        direct: host === undefined ? uri.connection_uri : withHost(uri.connection_uri, host),
        pooled: poolerHost === undefined ? uri.connection_uri : withHost(uri.connection_uri, poolerHost),
      }
    },
    async deleteBranch(projectId, branchId) {
      await request('DELETE', `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`)
    },
  }
}

const UUID = /[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i
const CloudflareResult = z.object({ result: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), content: z.string().optional() })) })
const TunnelList = z.array(z.looseObject({ id: z.string(), name: z.string() }))

async function succeeded(run: Run, args: readonly string[], env: Readonly<Record<string, string>>, label: string): Promise<string> {
  const result = await run(args, env)
  if (result.status === -1) throw new Error(`${label} could not start (${result.stderr.trim() || 'is it installed?'})`)
  if (result.status !== 0) throw new Error(`${label} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout
}

/** `cloudflared` through `run`, the Cloudflare DNS API through global fetch (Bearer `apiToken`). */
export function tunnelSeam(options: { run: Run; baseUrl?: string | undefined; apiToken: string | undefined }): TunnelSeam {
  const base = (options.baseUrl ?? CLOUDFLARE_BASE).replace(/\/+$/, '')
  const request = (method: string, path: string): Promise<unknown> => call('Cloudflare', method, `${base}${path}`, options.apiToken, 'CLOUDFLARE_API_TOKEN')
  const zones = new Map<string, string>()
  const zoneId = async (zone: string): Promise<string> => {
    const known = zones.get(zone)
    if (known !== undefined) return known
    const found = CloudflareResult.parse(await request('GET', `/zones?name=${encodeURIComponent(zone)}`)).result[0]
    if (found === undefined) throw new Error(`Cloudflare has no zone ${zone} for this token`)
    zones.set(zone, found.id)
    return found.id
  }
  return {
    async listTunnels() {
      const stdout = await succeeded(options.run, ['tunnel', 'list', '--output', 'json'], {}, 'cloudflared')
      return TunnelList.parse(stdout.trim() === '' ? [] : JSON.parse(stdout)).map((tunnel) => ({ id: tunnel.id, name: tunnel.name }))
    },
    async createTunnel(name) {
      const stdout = await succeeded(options.run, ['tunnel', 'create', name], {}, 'cloudflared')
      const id = UUID.exec(stdout)?.[0]
      if (id !== undefined) return id
      const listed = (await this.listTunnels()).find((tunnel) => tunnel.name === name)
      if (listed === undefined) throw new Error(`cloudflared created ${name} but did not report its id`)
      return listed.id
    },
    async routeDns(tunnel, hostname) {
      await succeeded(options.run, ['tunnel', 'route', 'dns', tunnel, hostname], {}, 'cloudflared')
    },
    async deleteTunnel(name) {
      await succeeded(options.run, ['tunnel', 'delete', '-f', name], {}, 'cloudflared')
    },
    async listCnames(zone, hostname) {
      const id = await zoneId(zone)
      const answer = CloudflareResult.parse(await request('GET', `/zones/${id}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`))
      return answer.result.map((record) => ({ id: record.id, name: record.name ?? hostname, content: record.content ?? '' }))
    },
    async deleteCname(zone, recordId) {
      await request('DELETE', `/zones/${await zoneId(zone)}/dns_records/${encodeURIComponent(recordId)}`)
    },
  }
}

const StripeList = z.object({ data: z.array(z.looseObject({ id: z.string(), url: z.string(), metadata: z.record(z.string(), z.string()).optional() })), has_more: z.boolean().optional() })
const StripeCreated = z.looseObject({ id: z.string(), secret: z.string().optional() })

/** The Stripe CLI through `run`. The key goes in the child environment as STRIPE_API_KEY, never on a command line. */
export function stripeSeam(options: { run: Run }): StripeSeam {
  const stripe = async (apiKey: string, args: readonly string[]): Promise<string> => succeeded(options.run, args, { STRIPE_API_KEY: apiKey }, 'stripe')
  return {
    async listEndpoints(apiKey) {
      const endpoints: StripeEndpoint[] = []
      let after: string | undefined
      for (;;) {
        const page = StripeList.parse(JSON.parse(await stripe(apiKey, ['webhook_endpoints', 'list', '--limit', '100', ...(after === undefined ? [] : ['--starting-after', after])])))
        for (const endpoint of page.data) endpoints.push({ id: endpoint.id, url: endpoint.url, metadata: endpoint.metadata ?? {} })
        const last = page.data.at(-1)
        if (page.has_more !== true || last === undefined) return endpoints
        after = last.id
      }
    },
    async createEndpoint(apiKey, spec) {
      const args = [
        'webhook_endpoints',
        'create',
        '--url',
        spec.url,
        ...spec.events.flatMap((event) => ['--enabled-events', event]),
        ...Object.entries(spec.metadata).flatMap(([key, value]) => ['-d', `metadata[${key}]=${value}`]),
        ...(spec.connect ? ['-d', 'connect=true'] : []),
      ]
      const created = StripeCreated.parse(JSON.parse(await stripe(apiKey, args)))
      if (created.secret === undefined || created.secret === '') throw new Error(`Stripe created ${created.id} but returned no signing secret`)
      return { id: created.id, secret: created.secret }
    },
    async deleteEndpoint(apiKey, id) {
      await stripe(apiKey, ['webhook_endpoints', 'delete', id, '--confirm'])
    },
  }
}

/** A real process as a Run. */
export function processRunner(command: string): Run {
  return (args, env) =>
    new Promise((resolve) => {
      let out = ''
      let err = ''
      let settled = false
      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const child = spawn(command, [...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
      child.on('error', (error) => finish({ status: -1, stdout: out, stderr: error.message }))
      child.on('close', (code) => finish({ status: code ?? -1, stdout: out, stderr: err }))
    })
}

/** Whether something accepts connections on 127.0.0.1:<port>. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/** The live seams, from the environment (keys, and the two optional base URL overrides). */
export function defaultSeams(env: Readonly<Record<string, string | undefined>> = process.env): IsolationSeams {
  return {
    neon: neonSeam({ baseUrl: env.NEON_API_BASE_URL, apiKey: env.NEON_API_KEY }),
    tunnel: tunnelSeam({ run: processRunner('cloudflared'), baseUrl: env.CLOUDFLARE_API_BASE_URL, apiToken: env.CLOUDFLARE_API_TOKEN }),
    stripe: stripeSeam({ run: processRunner('stripe') }),
    portBusy: probePort,
  }
}

type SyncRunner = (args: string[], options: { env: Record<string, string | undefined>; cwd?: string | undefined }) => { status: number | null; stdout: string; stderr: string }
/** The command-level seams a caller's options carry (base URLs, synchronous runners, a port probe), as IsolationSeams. */
export type CommandSeams = {
  neonBaseUrl: string
  cloudflareBaseUrl: string
  cloudflared: SyncRunner
  stripe: SyncRunner
  probePort: (port: number) => boolean | Promise<boolean>
  now?: () => Date
}

/** Adapts `CommandSeams` (what kit worktree, kit cleanup and kit doctor take as `options.seams`) to IsolationSeams. */
export function seamsFromCommand(seams: CommandSeams, env: Readonly<Record<string, string | undefined>> = process.env): IsolationSeams {
  const runner =
    (run: SyncRunner): Run =>
    (args, extra) => {
      const result = run([...args], { env: { ...env, ...extra } })
      return Promise.resolve({ status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr })
    }
  return {
    neon: neonSeam({ baseUrl: seams.neonBaseUrl, apiKey: env.NEON_API_KEY }),
    tunnel: tunnelSeam({ run: runner(seams.cloudflared), baseUrl: seams.cloudflareBaseUrl, apiToken: env.CLOUDFLARE_API_TOKEN }),
    stripe: stripeSeam({ run: runner(seams.stripe) }),
    portBusy: async (port) => seams.probePort(port),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Options and config.

export type IsolateOptions = {
  /** The main checkout's root: the lock lives in its `.work/`, siblings come from `git worktree list`. */
  main: string
  /** The worktree's project root: aspira.json is read there and `.aspira/cloudflared.yml` is written there. */
  worktree: string
  /** The ticket ID, such as SCOOP-7. */
  ticket: string
  seams: IsolationSeams
  /** Epoch milliseconds. */
  now: () => number
  /** The process environment (STRIPE_SECRET_KEY is read from it first, then the app's env files). */
  env: Readonly<Record<string, string | undefined>>
  /** The user's home directory: cloudflared keeps `<home>/.cloudflared/<UUID>.json`. */
  home: string
  /** One call per output line; it never receives a secret. */
  log: Log
}
export type TeardownOptions = Omit<IsolateOptions, 'now'>

/** The resource name of a ticket: its ID in lower case. */
export function worktreeName(ticket: string): string {
  return ticket.toLowerCase()
}

const BRANCH_DAYS = 14
const DAY_MS = 86_400_000
const LOCK_WAIT_MS = 300_000
const DEFAULT_URL_VARS = ['BETTER_AUTH_URL', 'NEXT_PUBLIC_APP_URL']

const Name = z.string().min(1)
const DatabaseConfig = z.object({
  provider: z.literal('neon'),
  projectId: Name,
  parentBranch: Name,
  envVars: z.array(z.union([Name, z.object({ name: Name, pooled: z.boolean().optional() })])).min(1),
})
const WebhookConfig = z.object({
  provider: z.string(),
  path: z.string(),
  events: z.array(Name).min(1),
  connect: z.boolean().optional(),
  secretEnvVar: Name.optional(),
  connectSecretEnvVar: Name.optional(),
})
const Keys = z.object({
  database: DatabaseConfig.optional(),
  tunnel: z.object({ zone: Name }).optional(),
  webhooks: z.array(WebhookConfig).optional(),
  dev: z.looseObject({ url: z.string().optional(), urlEnvVars: z.array(Name).optional() }).optional(),
})

type Plan = {
  name: string
  appDir: string
  appRel: string
  envFile: string
  yml: string
  database: z.infer<typeof DatabaseConfig> | undefined
  zone: string | undefined
  webhooks: Array<z.infer<typeof WebhookConfig>>
  urlTemplate: string | undefined
  urlVars: string[]
  wantsPort: boolean
  active: boolean
}

class StepError extends Error {
  constructor(
    readonly step: IsolationStep,
    reason: string,
  ) {
    super(reason)
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const PLACEHOLDER = /\{(name|port)\}/

function plan(options: Pick<IsolateOptions, 'worktree' | 'ticket'>): Plan {
  let config: ReturnType<typeof readAspira>
  try {
    config = readAspira(options.worktree)
  } catch (error) {
    throw new StepError('config', `aspira.json cannot be read: ${reasonOf(error)}`)
  }
  const parsed = Keys.safeParse({ database: config?.database, tunnel: config?.tunnel, webhooks: config?.webhooks, dev: config?.dev })
  if (!parsed.success) {
    throw new StepError('config', `aspira.json: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  const { database, tunnel, webhooks = [], dev } = parsed.data
  const app = typeof config?.app === 'string' && config.app !== '' && config.app !== '.' ? config.app : undefined
  const appDir = appRoot(options.worktree, app)
  const urlTemplate = dev?.url !== undefined && PLACEHOLDER.test(dev.url) ? dev.url : undefined
  const wantsPort = tunnel !== undefined || urlTemplate !== undefined
  return {
    name: worktreeName(options.ticket),
    appDir,
    appRel: app ?? '',
    envFile: join(appDir, '.env.development.local'),
    yml: join(options.worktree, '.aspira', 'cloudflared.yml'),
    database,
    zone: tunnel?.zone,
    webhooks,
    urlTemplate,
    urlVars: dev?.urlEnvVars ?? DEFAULT_URL_VARS,
    wantsPort,
    active: database !== undefined || tunnel !== undefined || webhooks.length > 0 || urlTemplate !== undefined,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Env files.

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = ENV_LINE.exec(line)
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

/** Sets KEY=value lines in place (new keys at the end), leaving every other line alone; writes only on a change. */
function updateEnvFile(file: string, updates: Readonly<Record<string, string>>): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  if (lines.at(-1) === '') lines.pop()
  const pending = new Map(Object.entries(updates))
  const next = lines.map((line) => {
    const key = ENV_LINE.exec(line)?.[1]
    const value = key === undefined ? undefined : pending.get(key)
    if (key === undefined || value === undefined) return line
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) next.push(`${key}=${value}`)
  const text = `${next.join('\n')}\n`
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, { mode: 0o600 })
}

// ---------------------------------------------------------------------------------------------------------------
// The lock: one setup or teardown at a time per main checkout, so a port choice and every check-then-create is atomic.

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function holderAlive(lock: string): boolean {
  let text: string
  try {
    text = readFileSync(lock, 'utf8').trim()
  } catch {
    return false
  }
  const pid = Number(text)
  if (!Number.isInteger(pid) || pid <= 0) return text === '' // being written right now
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function withLock<T>(main: string, work: () => Promise<T>): Promise<T> {
  const dir = join(main, '.work')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'isolation.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (!holderAlive(lock)) {
        rmSync(lock, { force: true }) // a lock whose process no longer runs is taken over
        continue
      }
      if (Date.now() > deadline) throw new StepError('config', `another isolation run holds ${lock}; remove it if no kit command is running`)
      await sleep(25)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, { force: true })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers.

const SECRET_SHAPES = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g
const redact = (text: string, ...secrets: Array<string | undefined>): string =>
  secrets.reduce<string>((safe, secret) => (secret === undefined || secret === '' ? safe : safe.split(secret).join('[redacted]')), text.replace(SECRET_SHAPES, '[redacted]'))

/** STRIPE_SECRET_KEY from the process environment first, then the app's env files (and the project root's). */
function stripeKey(options: Pick<IsolateOptions, 'env' | 'worktree'>, plan: Plan): string {
  const fromEnv = options.env.STRIPE_SECRET_KEY?.trim()
  let key = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
  for (const dir of [plan.appDir, options.worktree]) {
    for (const file of ['.env.local', '.env']) key ??= readEnvFile(join(dir, file)).STRIPE_SECRET_KEY || undefined
  }
  if (key === undefined) throw new StepError('webhooks', 'STRIPE_SECRET_KEY is not set in the environment or the app env files')
  if (/^(?:sk|rk)_live_/.test(key)) throw new StepError('webhooks', 'STRIPE_SECRET_KEY is a live-mode key; per-worktree webhooks are created in test mode only')
  return key
}

const hostOf = (plan: Plan, zone: string): string => `${plan.name}-branch.${zone}`
const tunnelName = (plan: Plan): string => `wt-${plan.name}`
const branchName = (plan: Plan): string => `wt/${plan.name}`
const kindOf = (endpoint: StripeEndpoint): 'connect' | 'account' => (endpoint.metadata.aspira_kind === 'connect' ? 'connect' : 'account')

function ymlTunnelId(plan: Plan): string | undefined {
  if (!existsSync(plan.yml)) return undefined
  return /^tunnel:\s*(\S+)\s*$/m.exec(readFileSync(plan.yml, 'utf8'))?.[1]
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------------------------------------------------------
// isolate.

function preflight(options: IsolateOptions, p: Plan): string | undefined {
  for (const hook of p.webhooks) {
    if (hook.provider !== 'stripe') throw new StepError('webhooks', `webhooks provider "${hook.provider}" is not supported: v1 supports Stripe only`)
  }
  for (const hook of p.webhooks) {
    if (!hook.path.startsWith('/')) throw new StepError('webhooks', `webhooks path "${hook.path}" must start with /`)
  }
  if (p.webhooks.length > 0 && p.zone === undefined) throw new StepError('webhooks', 'webhooks need the tunnel key in aspira.json ("tunnel": { "zone": ... }): they are registered at the worktree tunnel')
  if (!isGitIgnored(p.appDir, '.env.development.local')) {
    throw new StepError('env', `git does not ignore ${p.envFile}; add the line .env.development.local to .gitignore (kit init adds it) before the kit writes secrets there`)
  }
  if (p.zone !== undefined && !isGitIgnored(options.worktree, '.aspira/cloudflared.yml')) {
    throw new StepError('tunnel', `git does not ignore ${p.yml}; add the line .aspira/ to .gitignore (kit init adds it) before the kit writes the tunnel config there`)
  }
  return p.webhooks.length > 0 ? stripeKey(options, p) : undefined
}

async function databaseStep(options: IsolateOptions, p: Plan, database: NonNullable<Plan['database']>): Promise<boolean> {
  const { neon } = options.seams
  const vars = database.envVars.map((entry) => (typeof entry === 'string' ? { name: entry, pooled: true } : { name: entry.name, pooled: entry.pooled ?? true }))
  const branches = await neon.listBranches(database.projectId)
  const parent = branches.find((branch) => branch.name === database.parentBranch)
  if (parent === undefined) throw new StepError('database', `Neon project ${database.projectId} has no branch ${database.parentBranch} to parent ${branchName(p)} on`)
  if (parent.default) throw new StepError('database', `parentBranch ${database.parentBranch} is the project's default branch; a worktree branch copies its parent, so name a non-production branch such as dev`)
  const current = readEnvFile(p.envFile)
  const live = branches.find((branch) => branch.name === branchName(p))
  if (live !== undefined) {
    const missing = vars.filter((entry) => !current[entry.name]).map((entry) => entry.name)
    if (missing.length > 0) {
      throw new StepError('database', `${branchName(p)} exists but ${p.envFile} has no ${missing.join(', ')}; Neon returns connection strings only when it creates a branch, so restore the file or delete the branch in Neon and rerun`)
    }
    options.log(`database ${branchName(p)} exists, kept`)
    return false
  }
  const recreated = vars.some((entry) => current[entry.name])
  const created = await neon.createBranch(database.projectId, { name: branchName(p), parentId: parent.id, expiresAt: new Date(options.now() + BRANCH_DAYS * DAY_MS).toISOString() })
  updateEnvFile(p.envFile, Object.fromEntries(vars.map((entry) => [entry.name, entry.pooled ? created.pooled : created.direct])))
  options.log(`database ${branchName(p)} created from ${database.parentBranch} (expires in ${String(BRANCH_DAYS)} days); ${vars.map((entry) => entry.name).join(', ')} written`)
  if (recreated) {
    options.log(`database ${branchName(p)} was recreated: the old branch had expired, so its migrations are gone; rerun kit db migrate --name <migration> to apply them`)
  }
  return recreated
}

async function portStep(options: IsolateOptions, p: Plan): Promise<void> {
  const current = readEnvFile(p.envFile)
  let port = Number(current.PORT)
  if (!Number.isInteger(port) || port <= 0) {
    const claimed = new Set<number>()
    const own = canonical(options.worktree)
    for (const sibling of listWorktrees(options.main) ?? []) {
      if (canonical(sibling.path) === own) continue
      const claim = Number(readEnvFile(join(sibling.path, p.appRel, '.env.development.local')).PORT)
      if (Number.isInteger(claim)) claimed.add(claim)
    }
    port = 3001
    while (port <= 65_535 && (claimed.has(port) || (await options.seams.portBusy(port)))) port += 1
    if (port > 65_535) throw new StepError('port', 'no free port from 3001 up')
  }
  const updates: Record<string, string> = { PORT: String(port) }
  if (p.urlTemplate !== undefined) {
    const url = p.urlTemplate.replaceAll('{name}', p.name).replaceAll('{port}', String(port))
    for (const key of p.urlVars) updates[key] = url
  }
  updateEnvFile(p.envFile, updates)
  options.log(`port     ${String(port)}${p.urlTemplate === undefined ? '' : ` (${updates[p.urlVars[0] ?? ''] ?? ''})`}`)
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const q = (text: string): string => JSON.stringify(text)

function tunnelConfig(options: IsolateOptions, p: Plan, zone: string, id: string, port: string): string {
  const paths = [...new Set(p.webhooks.map((hook) => hook.path))]
  return [
    `tunnel: ${id}`,
    `credentials-file: ${q(join(options.home, '.cloudflared', `${id}.json`))}`,
    'ingress:',
    ...paths.flatMap((path) => [`  - hostname: ${hostOf(p, zone)}`, `    path: ${q(`^${escapeRegex(path)}$`)}`, `    service: http://localhost:${port}`]),
    '  - service: http_status:404',
    '',
  ].join('\n')
}

async function tunnelStep(options: IsolateOptions, p: Plan, zone: string): Promise<void> {
  const { tunnel } = options.seams
  const name = tunnelName(p)
  const host = hostOf(p, zone)
  const existing = (await tunnel.listTunnels()).find((candidate) => candidate.name === name)
  let id = existing?.id
  let route = false
  if (id === undefined) {
    id = await tunnel.createTunnel(name)
    route = true
    options.log(`tunnel   ${name} created`)
  } else {
    const records = await tunnel.listCnames(zone, host)
    const target = `${id}.cfargotunnel.com`
    if (records.some((record) => record.content !== target)) throw new StepError('tunnel', `${host} already points at ${records.find((record) => record.content !== target)?.content ?? 'another target'}, not ${name}; the kit will not replace a DNS record it did not make`)
    route = !records.some((record) => record.content === target)
    options.log(`tunnel   ${name} exists, kept`)
  }
  if (route) {
    await tunnel.routeDns(name, host)
    options.log(`tunnel   ${host} routed to ${name}`)
  }
  const text = tunnelConfig(options, p, zone, id, readEnvFile(p.envFile).PORT ?? '')
  if (!existsSync(p.yml) || readFileSync(p.yml, 'utf8') !== text) {
    mkdirSync(join(p.yml, '..'), { recursive: true })
    writeFileSync(p.yml, text)
  }
}

async function webhooksStep(options: IsolateOptions, p: Plan, zone: string, key: string): Promise<void> {
  const { stripe } = options.seams
  type Wanted = { url: string; kind: 'account' | 'connect'; events: string[]; secretVar: string }
  const wanted: Wanted[] = p.webhooks.flatMap((hook) => {
    const url = `https://${hostOf(p, zone)}${hook.path}`
    const account: Wanted = { url, kind: 'account', events: hook.events, secretVar: hook.secretEnvVar ?? 'STRIPE_WEBHOOK_SECRET' }
    return hook.connect === true ? [account, { ...account, kind: 'connect' as const, secretVar: hook.connectSecretEnvVar ?? 'STRIPE_CONNECT_WEBHOOK_SECRET' }] : [account]
  })
  const all = await stripe.listEndpoints(key)
  const mine = all.filter((endpoint) => endpoint.metadata.aspira_worktree === p.name)
  const stored = readEnvFile(p.envFile)
  const doomed: StripeEndpoint[] = []
  const missing: Wanted[] = []
  for (const want of wanted) {
    const found = mine.filter((endpoint) => endpoint.url === want.url && kindOf(endpoint) === want.kind)
    if (found.length > 0 && stored[want.secretVar]) continue
    doomed.push(...found) // a tagged endpoint whose secret was never stored cannot be used: Stripe shows the secret once
    missing.push(want)
  }
  if (missing.length > 0 && all.length - doomed.length + missing.length > 16) {
    throw new StepError('webhooks', `Stripe allows at most 16 webhook endpoints per account (limit 16) and this account has ${String(all.length - doomed.length)}, so ${String(missing.length)} more would pass the limit of 16; delete unused endpoints in the Stripe dashboard and rerun`)
  }
  for (const endpoint of doomed) {
    await stripe.deleteEndpoint(key, endpoint.id)
    options.log(`webhooks deleted ${endpoint.id} (no stored secret)`)
  }
  for (const want of missing) {
    const metadata = { aspira_worktree: p.name, ...(want.kind === 'connect' ? { aspira_kind: 'connect' } : {}) }
    const created = await stripe.createEndpoint(key, { url: want.url, events: want.events, metadata, connect: want.kind === 'connect' })
    updateEnvFile(p.envFile, { [want.secretVar]: created.secret })
    options.log(`webhooks ${want.kind} endpoint ${created.id} created at ${want.url}; ${want.secretVar} written`)
  }
  if (missing.length === 0) options.log('webhooks endpoints exist, kept')
}

/**
 * Brings the worktree to its isolated state: database, port and URL, tunnel, webhooks, each only when its
 * aspira.json key is present and each creating only what is missing. Resolves `{ ok: false, step, reason }` at the first step
 * that fails and keeps what the earlier steps made. Never throws.
 */
export async function isolate(options: IsolateOptions): Promise<IsolateResult> {
  let secret: string | undefined
  try {
    const p = plan(options)
    if (!p.active) return { ok: true, recreated: false }
    return await withLock(options.main, async () => {
      secret = preflight(options, p)
      const { database, zone, webhooks } = p
      const recreated = database === undefined ? false : await runStep('database', () => databaseStep(options, p, database))
      if (p.wantsPort) await runStep('port', () => portStep(options, p))
      if (zone !== undefined) await runStep('tunnel', () => tunnelStep(options, p, zone))
      if (webhooks.length > 0 && zone !== undefined && secret !== undefined) {
        const key = secret
        await runStep('webhooks', () => webhooksStep(options, p, zone, key))
      }
      await runStep('env', () => Promise.resolve(updateEnvFile(p.envFile, { ASPIRA_WORKTREE: p.name })))
      return { ok: true as const, recreated }
    })
  } catch (error) {
    return failure(error, secret)
  }
}

async function runStep<T>(step: IsolationStep, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw error instanceof StepError ? error : new StepError(step, reasonOf(error))
  }
}

function failure(error: unknown, secret: string | undefined): { ok: false; step: IsolationStep; reason: string } {
  const step = error instanceof StepError ? error.step : 'config'
  return { ok: false, step, reason: redact(reasonOf(error), secret) }
}

// ---------------------------------------------------------------------------------------------------------------
// teardown.

/**
 * Deletes what the kit marked for the ticket and nothing else: Stripe endpoints tagged aspira_worktree=<name>, the
 * wt-<name> tunnel and the CNAME that targets its UUID, and the wt/<name> Neon branch. A resource already gone is
 * skipped, so a rerun completes a half-finished teardown. Every step is tried; the first failure is returned. Never throws.
 */
export async function teardown(options: TeardownOptions): Promise<TeardownResult> {
  let p: Plan
  try {
    p = plan(options)
  } catch (error) {
    return failure(error, undefined)
  }
  if (!p.active) return { ok: true }
  let key: string | undefined
  try {
    return await withLock(options.main, async () => {
      const failures: Array<{ step: IsolationStep; reason: string }> = []
      const attempt = async (step: IsolationStep, work: () => Promise<void>): Promise<void> => {
        try {
          await work()
        } catch (error) {
          failures.push({ step, reason: reasonOf(error) })
        }
      }
      const stripeHooks = p.webhooks.filter((hook) => hook.provider === 'stripe')
      if (stripeHooks.length > 0) {
        await attempt('webhooks', async () => {
          key = stripeKey(options, p)
          for (const endpoint of await options.seams.stripe.listEndpoints(key)) {
            if (endpoint.metadata.aspira_worktree !== p.name) continue
            await options.seams.stripe.deleteEndpoint(key, endpoint.id)
            options.log(`webhooks deleted ${endpoint.id}`)
          }
        })
      }
      if (p.zone !== undefined) {
        const zone = p.zone
        await attempt('tunnel', async () => {
          const { tunnel } = options.seams
          const found = (await tunnel.listTunnels()).find((candidate) => candidate.name === tunnelName(p))
          const id = found?.id ?? ymlTunnelId(p)
          if (id !== undefined) {
            for (const record of await tunnel.listCnames(zone, hostOf(p, zone))) {
              if (record.content === `${id}.cfargotunnel.com`) {
                await tunnel.deleteCname(zone, record.id)
                options.log(`tunnel   deleted CNAME ${record.name}`)
              } else {
                options.log(`tunnel   left CNAME ${record.name} -> ${record.content}: it does not target this worktree's tunnel`)
              }
            }
          }
          if (found !== undefined) {
            await tunnel.deleteTunnel(found.name)
            options.log(`tunnel   deleted ${found.name}`)
          }
        })
      }
      if (p.database !== undefined) {
        const database = p.database
        await attempt('database', async () => {
          const live = (await options.seams.neon.listBranches(database.projectId)).find((branch) => branch.name === branchName(p))
          if (live === undefined) return
          await options.seams.neon.deleteBranch(database.projectId, live.id)
          options.log(`database deleted ${branchName(p)}`)
        })
      }
      const first = failures[0]
      return first === undefined ? { ok: true as const } : { ok: false as const, step: first.step, reason: redact(failures.map((entry) => `${entry.step}: ${entry.reason}`).join('; '), key) }
    })
  } catch (error) {
    return failure(error, key)
  }
}
