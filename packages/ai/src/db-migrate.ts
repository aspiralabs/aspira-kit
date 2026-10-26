// kit db migrate --name <n> [prisma args]: `prisma migrate dev` against the worktree's own Neon branch (KIT-67).
// It sets every database.envVars name from the worktree's .env.development.local and refuses, before prisma runs,
// when the branch URL is missing, the branch no longer exists in Neon, or the Prisma datasource reads a variable
// that database.envVars does not list (it would fall through to the shared dev database). It never passes --force
// and never resets; a prisma refusal is prisma's own message and exit 1.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { appRoot, readApp, readAspira } from './aspira.js'
import { defaultSeams, worktreeName, type NeonSeam } from './isolation.js'

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

export async function dbMigrate(options: DbMigrateOptions): Promise<number> {
  const config = readAspira(options.projectRoot)
  const database = config?.database
  if (database === undefined) {
    options.warn('aspira.json has no "database" key; kit db migrate runs against a worktree branch the kit created')
    return 1
  }
  const app = options.app ?? readApp(options.projectRoot)
  const appDir = appRoot(resolve(options.projectRoot), app)
  const values = parseEnv(join(appDir, ENV_FILE))
  const names = database.envVars.map((entry) => (typeof entry === 'string' ? entry : entry.name))
  const missing = names.filter((name) => values[name] === undefined || values[name] === '')
  if (missing.length > 0) {
    options.warn(`no branch URL: ${join(appDir, ENV_FILE)} lacks ${missing.join(', ')}; run kit worktree <ticket> to give this worktree its own database branch`)
    return 1
  }
  const folder = basename(resolve(options.projectRoot))
  const name = values['ASPIRA_WORKTREE'] ?? worktreeName(folder.slice(folder.indexOf('-') + 1))
  const env = options.env ?? process.env
  const neon = options.neon ?? defaultSeams(env).neon
  let branches
  try {
    branches = await neon.listBranches(database.projectId)
  } catch (error) {
    options.warn(`could not list the Neon branches: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (!branches.some((branch) => branch.name === `wt/${name}`)) {
    options.warn(`the Neon branch wt/${name} expired or was deleted; rerun kit worktree to recreate it, then kit db migrate`)
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
