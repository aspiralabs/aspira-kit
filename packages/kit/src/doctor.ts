// Reports which kit version a project is on and whether the wiring is present. The package-level
// items (package.json, node_modules, eslint, tsconfig, globals.css) live in the app that owns
// package.json (`--app`, or `app` in aspira.json; the root itself for a single-app project); the
// Claude-facing items (AGENTS.md, .mcp.json, .claude/, .gitignore, aspira.json) live at the root.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appRoot, checkAspira, isWorkspaceRoot, notionTargets, notionTokenCandidates, notionTokenSource, readAspira, readApp, type NotionTarget } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { isGitIgnored, repositoryRoot } from './git.js'
import { AGENTS_PACKAGE, agentPackageDir, checkSkills } from './skills.js'

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The hook command `kit init` writes: `sh <app>/node_modules/@aspiralabs/kit/hooks/<name>` from the project root. */
export const hookCommand = (app: string | undefined, name: string): string => `sh ${app ? `${app}/` : ''}node_modules/@aspiralabs/kit/hooks/${name}`

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

/** The default UrlChecker: spawns agent-common's check-notion-urls.ts with the project's env
 * files, the app's winning, the same way `kit next`'s liveResolver spawns resolve-ticket.ts.
 * Reports every key "unreachable" when agent-common (or amaro) is not installed, rather than
 * throwing, so a project that has not installed the agents yet still gets a healthy doctor run. */
export function liveUrlChecker(projectRoot: string, appDir: string): UrlChecker {
  return (checks) => {
    const unreachable = (reason: string): Record<string, UrlCheckResult> => Object.fromEntries(checks.map((check) => [check.key, { ok: false, unreachable: true, reason }]))
    const common = agentPackageDir(appDir, 'agent-common')
    if (common === undefined) return unreachable('@aspiralabs/agent-common is not installed; cannot check Notion')
    const script = join(common, 'scripts', 'check-notion-urls.ts')
    const amaro = findUpModule(realpathSync(common), join('amaro', 'dist', 'register-strip.mjs')) ?? findUpModule(realpathSync(appDir), join('amaro', 'dist', 'register-strip.mjs'))
    if (!existsSync(script) || amaro === undefined) return unreachable(existsSync(script) ? 'amaro (the TypeScript loader the agents ship with) is not installed' : `${script} is missing`)
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

export function doctor(projectRoot: string, log: Log, appFlag?: string, options?: { check?: UrlChecker; env?: Record<string, string | undefined> }): number {
  const app = appFlag ?? readApp(projectRoot)
  const appDir = appRoot(projectRoot, app)
  const pkg = readJson<Pkg>(join(appDir, 'package.json'))
  if (!pkg) {
    log(app ? `no package.json in ${app}` : 'no package.json here (in a repository whose app lives in a subdirectory, pass --app <dir>)')
    return 1
  }
  if (app) log(`app    ${app} (package.json and node_modules); Claude-facing files at ${projectRoot}`)
  let problems = 0
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const name of ['@aspiralabs/ui', '@aspiralabs/config', '@aspiralabs/kit', AGENTS_PACKAGE]) {
    const declared = all[name]
    const installed = readJson<{ version: string }>(join(appDir, 'node_modules', name, 'package.json'))?.version
    if (!declared) {
      log(`missing ${name}`)
      problems += 1
      continue
    }
    log(`${name.padEnd(20)} declared ${declared.padEnd(14)} installed ${installed ?? '(not installed)'}`)
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
  const settings = () => JSON.stringify(readJson(join(projectRoot, '.claude', 'settings.json')) ?? {})
  const mcp = () => JSON.stringify(readJson(join(projectRoot, '.mcp.json')) ?? {})
  const ignores = (entry: string) => existsSync(join(projectRoot, '.gitignore')) && new RegExp(`^${entry.replace('.', '\\.')}/?$`, 'm').test(readFileSync(join(projectRoot, '.gitignore'), 'utf8'))
  const gitRoot = gitRootOf(projectRoot)
  const rootIgnore = join(gitRoot ?? projectRoot, '.gitignore')
  const checks: Array<[string, (() => boolean) | 'skipped']> = [
    [`${inApp('eslint.config.mjs')} extends the kit`, () => existsSync(join(appDir, 'eslint.config.mjs')) && readFileSync(join(appDir, 'eslint.config.mjs'), 'utf8').includes('@aspiralabs/config')],
    [`${inApp('tsconfig.json')} extends the kit`, () => readJson<{ extends?: string }>(join(appDir, 'tsconfig.json'))?.extends?.includes('@aspiralabs/config') ?? false],
    [`${inApp('globals.css')} imports tokens`, () => ['app/globals.css', 'src/app/globals.css'].some((p) => existsSync(join(appDir, p)) && readFileSync(join(appDir, p), 'utf8').includes('@aspiralabs/ui/tokens.css'))],
    ['AGENTS.md has the managed block', () => existsSync(join(projectRoot, 'AGENTS.md')) && readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8').includes('aspiralabs:begin')],
    [app ? `.mcp.json registers aspiralabs-ui from ${app}/node_modules` : '.mcp.json registers aspiralabs-ui', () => mcp().includes('aspiralabs-ui') && (!app || mcp().includes(mcpServer(app).args[0]!))],
    [app ? `.claude/settings.json has the hooks from ${app}/node_modules` : '.claude/settings.json has the hooks', () => settings().includes(hookCommand(app, 'session-start.sh'))],
    ['.gitignore ignores .work/ (per-ticket working folders)', () => ignores('.work')],
    ['.gitignore ignores .aspira/ (the audit log the hooks write)', () => ignores('.aspira')],
    // Ticket worktrees live at the git repository root, and the .env.local symlinks kit worktree makes
    // must stay out of commits; outside a git repository neither applies.
    gitRoot === undefined
      ? ['.gitignore ignores .worktrees/ (skipped: not in a git repository)', 'skipped']
      : [`${gitRoot === projectRoot ? '.gitignore' : rootIgnore} ignores .worktrees/ (per-ticket git worktrees)`, () => existsSync(rootIgnore) && hasLine(readFileSync(rootIgnore, 'utf8'), WORKTREES_ENTRY[0])],
    gitRoot === undefined
      ? ['.env.local is git-ignored (skipped: not in a git repository)', 'skipped']
      : [`${envLocalPaths(app).join(' and ')} git-ignored (local secrets kit worktree links)`, () => envLocalIgnored(projectRoot, app)],
    ['no committed feature folders (specs, docs/plans, docs/working-feature)', () => !['specs', 'docs/plans', 'docs/working-feature'].some((p) => existsSync(join(projectRoot, p)))],
  ]
  // The Feature Board: aspira.json with a Notion URL, which the skills and kit next read.
  const aspira = checkAspira(projectRoot)
  checks.push([aspira.ok ? `aspira.json names the Feature Board${app ? ` and the app (${app})` : ''}` : aspira.reason ?? 'aspira.json', () => aspira.ok])
  // The /aspira-* skills: present, complete, and from the installed version of the package that ships
  // them (@aspiralabs/agents for the agent skills, @aspiralabs/kit for the kit's own).
  for (const skill of checkSkills(projectRoot, app)) {
    checks.push([skill.ok ? `.claude/skills/aspira-${skill.name} matches ${skill.package}` : skill.reason ?? `.claude/skills/aspira-${skill.name}`, () => skill.ok])
  }
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
  log(problems === 0 ? 'healthy' : `${problems} problem(s); run kit init --stack next${app ? ` --app ${app}` : ''} (and --board <Feature Board URL> when aspira.json is the problem)`)
  return problems === 0 ? 0 : 1
}
