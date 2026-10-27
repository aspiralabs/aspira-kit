// Reports which kit version a project is on and whether the wiring is present. The package-level
// items (package.json, node_modules, eslint, tsconfig, globals.css) live in the app that owns
// package.json (`--app`, or `app` in aspira.json; the root itself for a single-app project); the
// Claude-facing items (AGENTS.md, .mcp.json, .claude/, .gitignore, aspira.json) live at the root.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { appRoot, aspiraTracked, codebaseMapsFolder, checkAspira, readEffectiveAspira, type AspiraConfig, isWorkspaceRoot, notionTargets, notionTokenCandidates, notionTokenSource, readAspira, readApp, type NotionTarget } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { git, isGitIgnored, mainCheckoutRoot, repositoryRoot } from './git.js'
import type { CommandSeams } from './isolation.js'
import { AI_PACKAGE, aiPackageDir, aiVersion, harnessItems } from './skills.js'
import { harnessLeftovers } from './stacks/next.js'

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The MCP server entry `kit init` writes: the installed @aspiralabs/ui's server, run by node from the project root. */
export const mcpServer = (app: string): { command: string; args: string[] } => ({ command: 'node', args: [`${app}/node_modules/@aspiralabs/ui/bin/mcp.js`] })

/** One result per Notion key `kit doctor` resolves: `{ ok: true }`, a real failure with Notion's
 * status (401/403/404), or `{ unreachable: true }` (429, 5xx, a network error, or no token). */
export type UrlCheckResult = { ok: true } | { ok: false; status?: number; unreachable?: boolean; reason: string }

/** Resolves aspira.json's Notion keys. The production default (`liveUrlChecker`) is synchronous,
 * like `kit next`'s `liveResolver`; a test may inject one that returns a Promise instead, which
 * `doctor` cannot await (it is not itself async, to stay a drop-in for every existing caller), so
 * its result lands too late to be reflected in that call's own return value and lines. */
export type UrlChecker = (checks: NotionTarget[]) => Record<string, UrlCheckResult> | Promise<Record<string, UrlCheckResult>>

const isThenable = (value: unknown): value is PromiseLike<Record<string, UrlCheckResult>> => typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'

/** The first `<ancestor of dir>/node_modules/<relative>` that exists, as Node resolution would find it (matches `kit next`'s own amaro lookup). */
function findUpModule(dir: string, relative: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    if (dirname(current) === current) return undefined
  }
}

/** The default UrlChecker: spawns the common folder's check-notion-urls.ts with the project's env
 * files, the app's winning, the same way `kit next`'s liveResolver spawns resolve-ticket.ts.
 * Reports every key "unreachable" when amaro is not found, rather than throwing, so the doctor run still finishes. */
export function liveUrlChecker(projectRoot: string, appDir: string): UrlChecker {
  return (checks) => {
    const unreachable = (reason: string): Record<string, UrlCheckResult> => Object.fromEntries(checks.map((check) => [check.key, { ok: false, unreachable: true, reason }]))
    const ai = aiPackageDir()
    if (ai === undefined) return unreachable('@aspiralabs/ai is not installed; cannot check Notion')
    const common = join(ai, 'common')
    const script = join(common, 'scripts', 'check-notion-urls.ts')
    if (!existsSync(script)) return unreachable(`${script} is missing`)
    const amaro = findUpModule(realpathSync(common), join('amaro', 'dist', 'register-strip.mjs')) ?? findUpModule(realpathSync(appDir), join('amaro', 'dist', 'register-strip.mjs'))
    if (amaro === undefined) return unreachable('amaro (the TypeScript loader the agents ship with) is not installed')
    const envFiles = [...new Set([join(projectRoot, '.env.local'), join(appDir, '.env.local')])].filter((file) => existsSync(file))
    const args = ['--import', amaro, '--experimental-strip-types', ...envFiles.map((file) => `--env-file=${file}`), script, ...checks.map((check) => `${check.key}=${check.url}`)]
    const run = spawnSync('node', args, { cwd: projectRoot, encoding: 'utf8' })
    if (run.status !== 0) return unreachable((run.stderr ?? 'the Notion check failed').split('\n')[0] ?? 'the Notion check failed')
    const byKey = new Map((run.stdout ?? '').split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    const out: Record<string, UrlCheckResult> = {}
    for (const check of checks) {
      const raw = byKey.get(check.key)
      if (raw === undefined) out[check.key] = { ok: false, unreachable: true, reason: 'no answer from the Notion check' }
      else if (raw === 'ok') out[check.key] = { ok: true }
      else if (raw.startsWith('unreachable:')) out[check.key] = { ok: false, unreachable: true, reason: raw.slice('unreachable:'.length) }
      else if (raw.startsWith('failed:')) {
        const [, status, ...rest] = raw.split(':')
        out[check.key] = { ok: false, status: status ? Number(status) : undefined, reason: rest.join(':') }
      } else out[check.key] = { ok: false, unreachable: true, reason: raw }
    }
    return out
  }
}

/** The ignore line for ticket worktrees, written to and checked in the git repository root's .gitignore. */
export const WORKTREES_ENTRY = ['.worktrees/', '# per-ticket git worktrees (kit worktree <ID> makes .worktrees/<TYPE>-<ID>)'] as const

/** The ignore line for local secrets, written to the project's .gitignore unless git already ignores every linked .env.local. */
export const ENV_LOCAL_ENTRY = ['.env.local', '# local secrets such as NOTION_TOKEN; kit worktree links them into each ticket worktree'] as const

/** The ignore line for the per-worktree env file kit worktree writes, added when aspira.json isolates (database, tunnel, webhooks or a placeholder dev.url). */
export const ENV_DEVELOPMENT_ENTRY = ['.env.development.local', '# per-worktree database URL, port and webhook secrets that kit worktree writes'] as const

/** Whether aspira.json asks for isolation: a database, a tunnel, webhooks, or a dev.url with a {name} or {port} placeholder. */
export const isolates = (config: Partial<AspiraConfig> | undefined): boolean =>
  config?.database !== undefined || config?.tunnel !== undefined || (config?.webhooks?.length ?? 0) > 0 || /\{(name|port)\}/.test(config?.dev?.url ?? '')

/** Whether git ignores the app's .env.development.local (the root's when there is no app), asked of git at the project root. */
export const envDevelopmentIgnored = (projectRoot: string, app: string | undefined): boolean => isGitIgnored(projectRoot, app ? `${app}/.env.development.local` : '.env.development.local')

/** Whether `text` (a .gitignore body) has `entry` as an exact line. */
export const hasLine = (text: string, entry: string): boolean => text.split('\n').some((line) => line.trimEnd() === entry)

/** The .env.local paths kit worktree links, relative to the project root: the root's, and the app's when there is one. */
export const envLocalPaths = (app: string | undefined): string[] => (app ? ['.env.local', `${app}/.env.local`] : ['.env.local'])

/** Whether git ignores every .env.local path kit worktree links, asked of git at the project root. */
export const envLocalIgnored = (projectRoot: string, app: string | undefined): boolean => envLocalPaths(app).every((path) => isGitIgnored(projectRoot, path))

/** The git repository root holding `projectRoot` (where ticket worktrees live): `projectRoot` itself when they are the same folder, undefined outside a git repository. */
export function gitRootOf(projectRoot: string): string | undefined {
  const root = repositoryRoot(projectRoot)
  if (root === undefined) return undefined
  return realpathSync(root) === realpathSync(projectRoot) ? projectRoot : root
}

/** Whether an aspira.json is in `projectRoot` or a folder above it, up to the git top-level (or `projectRoot` alone outside git). */
function hasAspiraJson(projectRoot: string, gitRoot: string | undefined): boolean {
  for (let dir = projectRoot; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'aspira.json'))) return true
    if (dir === (gitRoot ?? projectRoot) || dirname(dir) === dir) return false
  }
}

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** Whether an executable `name` is in a directory of env.PATH. */
function onPath(name: string, env: Record<string, string | undefined>): boolean {
  return (env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, name)))
}

/** Stripe endpoints tagged aspira_worktree=<name> where no .worktrees/<TYPE>-<name> folder exists (case-insensitive), sorted by name; all pages. */
function staleEndpoints(projectRoot: string, apiKey: string, env: Record<string, string | undefined>, seams: CommandSeams | undefined): Array<{ id: string; url: string; name: string }> {
  const run: CommandSeams['stripe'] = seams?.stripe ?? ((args, options) => spawnSync('stripe', args, { env: options.env as NodeJS.ProcessEnv, encoding: 'utf8' }))
  const runEnv = { ...env, STRIPE_API_KEY: apiKey }
  const endpoints: Array<{ id: string; url: string; metadata?: Record<string, string> }> = []
  for (let after: string | undefined; ; ) {
    const result = run(['webhook_endpoints', 'list', '--limit', '100', ...(after === undefined ? [] : ['--starting-after', after])], { env: runEnv })
    if (result.status !== 0) throw new Error((result.stderr ?? '').split('\n')[0] || 'the Stripe CLI failed')
    const page = JSON.parse(result.stdout) as { data: typeof endpoints; has_more?: boolean }
    endpoints.push(...page.data)
    const last = page.data.at(-1)
    if (page.has_more !== true || last === undefined) break
    after = last.id
  }
  const dir = join(gitRootOf(projectRoot) ?? projectRoot, '.worktrees')
  const folders = existsSync(dir) ? readdirSync(dir).map((name) => name.toLowerCase()) : []
  return endpoints
    .flatMap((endpoint) => (endpoint.metadata?.aspira_worktree ? [{ id: endpoint.id, url: endpoint.url, name: endpoint.metadata.aspira_worktree }] : []))
    .filter(({ name }) => !folders.some((folder) => folder === name.toLowerCase() || folder.endsWith(`-${name.toLowerCase()}`)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** KIT-69: one information line with the codebase map's freshness (`fresh`, `stale` or `missing`) and its root, from
 * `kit map-codebase --check` run through node + amaro. Informational only: it never adds to the problem count. */
function mapLine(projectRoot: string): string | undefined {
  try {
    const repo = repositoryRoot(projectRoot)
    const ai = aiPackageDir()
    if (repo === undefined || ai === undefined) return undefined
    const folder = codebaseMapsFolder(projectRoot, repo)
    const mapRoot = folder === undefined ? join(repo, '.codebase-map') : join(folder, basename(mainCheckoutRoot(repo) ?? repo))
    const script = join(ai, 'codebase-map', 'scripts', 'cli.ts')
    const amaro = findUpModule(realpathSync(ai), join('amaro', 'dist', 'register-strip.mjs')) ?? findUpModule(realpathSync(repo), join('amaro', 'dist', 'register-strip.mjs'))
    if (!existsSync(script) || amaro === undefined) return `map   not checked (${mapRoot})`
    const run = spawnSync('node', ['--import', amaro, '--experimental-strip-types', script, '--repo', repo, '--map-root', mapRoot, '--check'], { cwd: repo, encoding: 'utf8' })
    const state = /^(fresh|stale|missing)\b/.exec(run.stdout ?? '')?.[1]
    return state === undefined ? `map   not checked (${mapRoot})` : `map   ${state} (${mapRoot})`
  } catch {
    return undefined
  }
}

/** Whether any file under `dir` holds the rule id `REV-001`. */
function mentionsRule(dir: string, rule: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? mentionsRule(path, rule) : entry.isFile() && readFileSync(path, 'utf8').includes(rule)
  })
}

/** KIT-68: `kit doctor` at a client root (an aspira.json with `repos` in this folder). Checks the client keys, the guidelines
 * folder, the extend files and the Aspira files inside each mapped repo; board, Notion and @aspiralabs package checks do not apply. */
function doctorClient(projectRoot: string, file: string, log: Log, home: string | undefined): number {
  let problems = 0
  const report = (ok: boolean, label: string): void => {
    if (!ok) problems += 1
    log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  }
  log(`client ${projectRoot}`)
  const status = checkAspira(projectRoot)
  report(status.ok, status.ok ? 'aspira.json client keys are valid' : status.reason ?? 'aspira.json')
  const { config } = readEffectiveAspira(projectRoot)
  if (config.guidelines !== undefined) {
    const folder = resolve(projectRoot, config.guidelines)
    if (existsSync(folder) && statSync(folder).isDirectory()) report(mentionsRule(folder, 'REV-001'), `guidelines ${folder} ${mentionsRule(folder, 'REV-001') ? 'holds REV-001' : 'has no REV-001 rule'}`)
  }
  for (const [stage, files] of Object.entries(config.extend ?? {})) {
    for (const rel of files) report(existsSync(resolve(projectRoot, rel)), `extend ${stage} lists ${rel}${existsSync(resolve(projectRoot, rel)) ? '' : ', which does not exist'}`)
  }
  for (const [key, entry] of Object.entries(config.repos ?? {})) {
    const repoDir = resolve(projectRoot, String(entry?.path ?? ''))
    if (!existsSync(repoDir)) continue
    for (const name of ['aspira.json', '.work']) {
      const shown = join(String(entry.path), name)
      if (git(repoDir, ['ls-files', '--', name]).stdout.trim() !== '') report(false, `${shown} is tracked by git in repo ${key}; run kit upgrade there`)
      else if (existsSync(join(repoDir, name)) && !isGitIgnored(repoDir, name)) report(false, `${shown} is not git-ignored in repo ${key}`)
    }
  }
  const harness = harnessItems({ home })
  for (const item of harness) report(item.ok, item.ok ? item.label : item.reason ?? item.label)
  log(problems === 0 ? 'healthy' : `${problems} problem(s)${harness.some((item) => !item.ok) ? '; run kit update for the global harness' : ''}`)
  return problems === 0 ? 0 : 1
}

export function doctor(projectRoot: string, log: Log, appFlag?: string, options?: { check?: UrlChecker; env?: Record<string, string | undefined>; seams?: CommandSeams; home?: string }): number {
  const clientFile = join(projectRoot, 'aspira.json')
  if (existsSync(clientFile) && readJson<{ repos?: unknown }>(clientFile)?.repos !== undefined) return doctorClient(projectRoot, clientFile, log, options?.home)
  const app = appFlag ?? readApp(projectRoot)
  const appDir = appRoot(projectRoot, app)
  const pkg = readJson<Pkg>(join(appDir, 'package.json'))
  try {
    const ignored = readEffectiveAspira(projectRoot).ignored
    if (ignored !== undefined) log(`warn ignored aspira.json ${ignored}: its repos do not map this repository`)
  } catch {
    // an unreadable parent file is reported by the checks that read it
  }
  if (!pkg) {
    log(app ? `no package.json in ${app}` : 'no package.json here (in a repository whose app lives in a subdirectory, pass --app <dir>)')
    return 1
  }
  if (app) log(`app    ${app} (package.json and node_modules); Claude-facing files at ${projectRoot}`)
  let problems = 0
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const name of ['@aspiralabs/ui', '@aspiralabs/config']) {
    const declared = all[name]
    const installed = readJson<{ version: string }>(join(appDir, 'node_modules', name, 'package.json'))?.version
    if (!declared) {
      log(`missing ${name}`)
      problems += 1
      continue
    }
    log(`${name.padEnd(20)} declared ${declared.padEnd(14)} installed ${installed ?? '(not installed)'}`)
  }
  // @aspiralabs/ai is installed globally, once per engineer; a project copy (an earlier kit's devDependency) would win over it.
  if (all[AI_PACKAGE] !== undefined) {
    log(`FAIL ${AI_PACKAGE} is in ${app ? `${app}/` : ''}package.json; it is installed globally now: pnpm remove ${AI_PACKAGE}${app ? ` (in ${app})` : ''}, then kit init`)
    problems += 1
  } else {
    log(`${AI_PACKAGE.padEnd(20)} global ${aiVersion() ?? '(not found)'}`)
  }
  // A workspace root that declares @aspiralabs packages itself (shared eslint or prettier config) keeps them on the app's version.
  if (isWorkspaceRoot(projectRoot, app)) {
    const root = readJson<Pkg>(join(projectRoot, 'package.json')) ?? {}
    for (const [name, declared] of Object.entries({ ...root.dependencies, ...root.devDependencies }).filter(([name]) => name.startsWith('@aspiralabs/'))) {
      const same = declared === all[name]
      log(`${same ? 'ok  ' : 'FAIL'} workspace root declares ${name} ${declared}${same ? ', as the app does' : `, the app ${all[name] ?? 'does not'}`}`)
      if (!same) problems += 1
    }
  }
  const inApp = (file: string) => (app ? `${app}/${file}` : file)
  const mcp = () => JSON.stringify(readJson(join(projectRoot, '.mcp.json')) ?? {})
  const gitRoot = gitRootOf(projectRoot)
  const checks: Array<[string, (() => boolean) | 'skipped']> = [
    [`${inApp('eslint.config.mjs')} extends the kit`, () => existsSync(join(appDir, 'eslint.config.mjs')) && readFileSync(join(appDir, 'eslint.config.mjs'), 'utf8').includes('@aspiralabs/config')],
    [`${inApp('tsconfig.json')} extends the kit`, () => readJson<{ extends?: string }>(join(appDir, 'tsconfig.json'))?.extends?.includes('@aspiralabs/config') ?? false],
    [`${inApp('globals.css')} imports tokens`, () => ['app/globals.css', 'src/app/globals.css'].some((p) => existsSync(join(appDir, p)) && readFileSync(join(appDir, p), 'utf8').includes('@aspiralabs/ui/tokens.css'))],
    [app ? `.mcp.json registers aspiralabs-ui from ${app}/node_modules` : '.mcp.json registers aspiralabs-ui', () => mcp().includes('aspiralabs-ui') && (!app || mcp().includes(mcpServer(app).args[0]!))],
    gitRoot === undefined
      ? ['.env.local is git-ignored (skipped: not in a git repository)', 'skipped']
      : [`${envLocalPaths(app).join(' and ')} git-ignored (local secrets kit worktree links)`, () => envLocalIgnored(projectRoot, app)],
    ['no committed feature folders (specs, docs/plans, docs/working-feature)', () => !['specs', 'docs/plans', 'docs/working-feature'].some((p) => existsSync(join(projectRoot, p)))],
  ]
  // The Feature Board: aspira.json with a Notion URL, which the skills and kit next read.
  const aspira = checkAspira(projectRoot)
  checks.push([aspira.ok ? `aspira.json names the Feature Board${app ? ` and the app (${app})` : ''}` : aspira.reason ?? 'aspira.json', () => aspira.ok])
  // aspira.json is git-ignored and never committed (KIT-71); one an earlier kit committed is still tracked until kit upgrade.
  if (aspiraTracked(projectRoot)) checks.push(['aspira.json is tracked by git; run kit upgrade (it stops tracking the file and keeps it)', () => false])
  // The global harness (~/.claude skills and hooks, settings.json, the global git ignore): one line per item, from the same
  // predicate the kit self-heals with. Then whatever an earlier kit committed into the project, one failing line each.
  const harness = harnessItems({ home: options?.home })
  for (const item of harness) {
    checks.push([item.ok ? item.label : item.reason ?? item.label, () => item.ok])
  }
  for (const leftover of harnessLeftovers(projectRoot)) {
    checks.push([`${leftover.label} is left from an earlier kit; kit upgrade removes it`, () => false])
  }
  // The tier-3 deny hook is global and only guards a repository that has an aspira.json.
  if (!hasAspiraJson(projectRoot, gitRoot)) log('skip the tier-3 deny hook does not apply in this repository (no aspira.json from here up to the git root)')
  for (const [label, ok] of checks) {
    if (ok === 'skipped') {
      log(`skip ${label}`)
      continue
    }
    const pass = ok()
    if (!pass) {
      problems += 1
    }
    log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }
  // Isolation (KIT-67): the ignore line is a counted check; the keys and tools it needs are advice only.
  const config = readAspira(projectRoot)
  if (isolates(config)) {
    const env = options?.env ?? process.env
    const ignored = gitRoot === undefined ? hasLine(readText(join(projectRoot, '.gitignore')), ENV_DEVELOPMENT_ENTRY[0]) : envDevelopmentIgnored(projectRoot, app)
    log(`${ignored ? 'ok  ' : 'FAIL'} ${inApp('.env.development.local')} git-ignored (per-worktree secrets kit worktree writes)`)
    if (!ignored) problems += 1
    const warn = (text: string) => log(`warn ${text}`)
    const stripeHooks = (config?.webhooks ?? []).filter((hook) => hook.provider === 'stripe')
    const tunnels = config?.tunnel !== undefined || stripeHooks.length > 0
    if (config?.database !== undefined && !env.NEON_API_KEY?.trim()) warn('NEON_API_KEY is not set: kit worktree cannot branch the database')
    if (tunnels) {
      if (!env.CLOUDFLARE_API_TOKEN?.trim()) warn('CLOUDFLARE_API_TOKEN is not set: kit worktree cannot route the tunnel hostname')
      if (!onPath('cloudflared', env)) warn('cloudflared is not installed or not on PATH: kit worktree cannot run the tunnel')
      if (!existsSync(join(env.HOME ?? '', '.cloudflared', 'cert.pem'))) warn('cloudflared login cert (~/.cloudflared/cert.pem) is missing: run cloudflared tunnel login')
    }
    if (stripeHooks.length > 0) {
      if (!onPath('stripe', env)) warn('the Stripe CLI (stripe) is not installed or not on PATH: kit worktree cannot create webhook endpoints')
      const key = env.STRIPE_SECRET_KEY?.trim()
      if (key && !key.startsWith('sk_live_') && !key.startsWith('rk_live_')) {
        try {
          for (const stale of staleEndpoints(projectRoot, key, env, options?.seams)) warn(`Stripe endpoint ${stale.id} (${stale.url}) is tagged for worktree ${stale.name}, which has no folder in .worktrees/; delete it in the Stripe dashboard`)
        } catch (error) {
          warn(`Stripe endpoints not listed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  // aspira.json's Notion URLs (board, releases, glossary, decisions once set) and the NOTION_TOKEN
  // they need. A missing or unreachable token/check is advisory (doctor does not fail for it: the
  // project may not have wired Notion access up yet); only a real 401/403/404 against one of the
  // URLs is a problem, since that means aspira.json itself is misconfigured.
  const targets = notionTargets(readAspira(projectRoot))
  if (targets.length > 0) {
    const env = options?.env ?? process.env
    const tokenInfo = notionTokenSource(projectRoot, app, env)
    if (tokenInfo) log(`ok   NOTION_TOKEN from ${tokenInfo.source}`)
    else log(`FAIL NOTION_TOKEN is not set: checked ${notionTokenCandidates(app).join(', ')}`)
    const check = options?.check ?? liveUrlChecker(projectRoot, appDir)
    const maybeResult = check(targets) // always called, even with no token: it is the check's own job to say so
    if (!tokenInfo) {
      for (const target of targets) log(`not checked: no NOTION_TOKEN: ${target.key} (${target.url})`)
    } else if (isThenable(maybeResult)) {
      void Promise.resolve(maybeResult).catch(() => {})
    } else {
      for (const target of targets) {
        const result = maybeResult[target.key]
        if (result === undefined) continue
        if (result.ok) log(`ok   Notion ${target.key} (${target.url})`)
        else if (result.status !== undefined) {
          log(`FAIL Notion ${target.key} (${target.url}) is not reachable: Notion returned ${result.status}${result.reason ? ` (${result.reason})` : ''}`)
          problems += 1
        } else log(`not checked: Notion unreachable (${result.reason}): ${target.key} (${target.url})`)
      }
    }
  }
  const globalFailed = harness.some((item) => !item.ok)
  const projectFailed = problems > (globalFailed ? harness.filter((item) => !item.ok).length : 0)
  const hints = [
    ...(globalFailed ? ['run kit update for the global harness'] : []),
    ...(projectFailed || !globalFailed ? [`run kit init --stack next${app ? ` --app ${app}` : ''} (and --board <Feature Board URL> when aspira.json is the problem)`] : []),
  ]
  const map = mapLine(projectRoot)
  if (map !== undefined) log(map)
  log(problems === 0 ? 'healthy' : `${problems} problem(s); ${hints.join('; ')}`)
  return problems === 0 ? 0 : 1
}
