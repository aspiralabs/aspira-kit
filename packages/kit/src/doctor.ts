// Reports which kit version a project is on and whether the wiring is present. The package-level
// items (package.json, node_modules, eslint, tsconfig, globals.css) live in the app that owns
// package.json (`--app`, or `app` in aspira.json; the root itself for a single-app project); the
// Claude-facing items (AGENTS.md, .mcp.json, .claude/, .gitignore, aspira.json) live at the root.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { appRoot, checkAspira, isWorkspaceRoot, readApp } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { isGitIgnored, repositoryRoot } from './git.js'
import { AGENTS_PACKAGE, checkSkills } from './skills.js'

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The hook command `kit init` writes: `sh <app>/node_modules/@aspiralabs/kit/hooks/<name>` from the project root. */
export const hookCommand = (app: string | undefined, name: string): string => `sh ${app ? `${app}/` : ''}node_modules/@aspiralabs/kit/hooks/${name}`

/** The MCP server entry `kit init` writes: the installed @aspiralabs/ui's server, run by node from the project root. */
export const mcpServer = (app: string): { command: string; args: string[] } => ({ command: 'node', args: [`${app}/node_modules/@aspiralabs/ui/bin/mcp.js`] })

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

export function doctor(projectRoot: string, log: Log, appFlag?: string): number {
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
  log(problems === 0 ? 'healthy' : `${problems} problem(s); run kit init --stack next${app ? ` --app ${app}` : ''} (and --board <Feature Board URL> when aspira.json is the problem)`)
  return problems === 0 ? 0 : 1
}
