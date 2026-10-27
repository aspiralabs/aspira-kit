// kit db migrate --name <n> [prisma args]: `prisma migrate dev` against the worktree's own Neon branch (KIT-67).
// It sets every database.envVars name from the worktree's .env.development.local and refuses, before prisma runs,
// when the branch URL is missing, the branch no longer exists in Neon, or the Prisma datasource reads a variable
// that database.envVars does not list (it would fall through to the shared dev database). It never passes --force
// and never resets; a prisma refusal is prisma's own message and exit 1.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appRoot, readEffectiveAspira, type AspiraConfig } from './aspira.js'
import { defaultSeams, type NeonSeam } from './isolation.js'

export type DbMigrateOptions = {
  projectRoot: string
  app?: string | undefined
  name: string
  /** Arguments after --name <n> that go to prisma unchanged. */
  passthrough: readonly string[]
  log: (line: string) => void
  warn: (line: string) => void
  env?: Readonly<Record<string, string | undefined>>
  neon?: NeonSeam
  /** The hosts of a branch's endpoints; defaults to the Neon API's GET /projects/{id}/branches/{id}/endpoints. */
  endpointHosts?: (projectId: string, branchId: string) => Promise<string[]>
}

const ENV_FILE = '.env.development.local'

function parseEnv(file: string): Record<string, string> {
  const values: Record<string, string> = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

/** The env() names the Prisma datasource (schema.prisma) and prisma.config.ts read. */
function datasourceVariables(appDir: string): string[] {
  const names = new Set<string>()
  for (const schema of [join(appDir, 'prisma', 'schema.prisma'), join(appDir, 'schema.prisma')]) {
    if (!existsSync(schema)) continue
    for (const block of readFileSync(schema, 'utf8').matchAll(/datasource\s+\w+\s*\{([^}]*)\}/g)) {
      for (const match of (block[1] ?? '').matchAll(/env\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g)) if (match[1] !== undefined) names.add(match[1])
    }
  }
  const config = join(appDir, 'prisma.config.ts')
  if (existsSync(config)) {
    for (const match of readFileSync(config, 'utf8').matchAll(/\benv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g)) if (match[1] !== undefined) names.add(match[1])
  }
  return [...names]
}

async function neonEndpointHosts(env: Readonly<Record<string, string | undefined>>, projectId: string, branchId: string): Promise<string[]> {
  const base = (env['NEON_API_BASE_URL'] ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '')
  const response = await fetch(`${base}/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/endpoints`, {
    headers: { Authorization: `Bearer ${env['NEON_API_KEY'] ?? ''}`, Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Neon GET endpoints answered ${String(response.status)}`)
  const body = (await response.json()) as { endpoints?: Array<{ host?: unknown }> }
  return (body.endpoints ?? []).flatMap((endpoint) => (typeof endpoint.host === 'string' ? [endpoint.host] : []))
}

/** The host of a connection string, or undefined when it does not parse. */
function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

export async function dbMigrate(options: DbMigrateOptions): Promise<number> {
  const config = readEffectiveAspira(options.projectRoot).config as Partial<AspiraConfig>
  const database = config?.database
  if (database === undefined) {
    options.warn('aspira.json has no "database" key; kit db migrate runs against a worktree branch the kit created')
    return 1
  }
  const app = options.app ?? (config.app === undefined || config.app === '' || config.app === '.' ? undefined : config.app)
  const appDir = appRoot(resolve(options.projectRoot), app)
  const values = parseEnv(join(appDir, ENV_FILE))
  const names = database.envVars.map((entry) => (typeof entry === 'string' ? entry : entry.name))
  const missing = names.filter((name) => values[name] === undefined || values[name] === '')
  if (missing.length > 0) {
    options.warn(`no branch URL: ${join(appDir, ENV_FILE)} lacks ${missing.join(', ')}; run kit worktree <ticket> to give this worktree its own database branch`)
    return 1
  }
  const name = values['ASPIRA_WORKTREE']
  if (name === undefined || name === '') {
    options.warn(`${join(appDir, ENV_FILE)} has no ASPIRA_WORKTREE: this checkout was not isolated by the kit; run kit worktree <ticket> to give it its own database branch`)
    return 1
  }
  const env = options.env ?? process.env
  const neon = options.neon ?? defaultSeams(env).neon
  let branches
  try {
    branches = await neon.listBranches(database.projectId)
  } catch (error) {
    options.warn(`could not list the Neon branches: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const branch = branches.find((candidate) => candidate.name === `wt/${name}`)
  if (branch === undefined) {
    options.warn(`the Neon branch wt/${name} expired or was deleted; rerun kit worktree to recreate it, then kit db migrate`)
    return 1
  }
  let hosts: string[]
  try {
    hosts = await (options.endpointHosts ?? ((projectId, branchId) => neonEndpointHosts(env, projectId, branchId)))(database.projectId, branch.id)
  } catch (error) {
    options.warn(`could not list the endpoints of the Neon branch wt/${name}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  // A pooled host is the endpoint host with -pooler after the endpoint id (ep-x-123-pooler.region.aws.neon.tech).
  const allowed = new Set(hosts.flatMap((host) => [host, host.replace(/^([^.]+)/, '$1-pooler')]))
  const foreign = names.filter((variable) => !allowed.has(urlHost(values[variable] as string) ?? ''))
  if (foreign.length > 0) {
    options.warn(`${foreign.join(', ')} in ${join(appDir, ENV_FILE)} does not point at an endpoint of the Neon branch wt/${name}; it could reach the shared database. Rerun kit worktree to rewrite it`)
    return 1
  }
  const unlisted = datasourceVariables(appDir).filter((variable) => !names.includes(variable))
  if (unlisted.length > 0) {
    options.warn(`the Prisma datasource reads ${unlisted.join(', ')}, which aspira.json database.envVars does not list; it would reach the shared database. Add it to envVars and rerun kit worktree`)
    return 1
  }
  const branchEnv = Object.fromEntries(names.map((variable) => [variable, values[variable] as string]))
  const bin = join(appDir, 'node_modules', '.bin')
  const result = spawnSync('prisma', ['migrate', 'dev', '--name', options.name, ...options.passthrough], {
    cwd: appDir,
    env: { ...env, ...branchEnv, PATH: `${bin}:${env['PATH'] ?? ''}` },
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    options.warn(`could not run prisma: ${result.error.message}`)
    return 1
  }
  return result.status === 0 ? 0 : 1
}
