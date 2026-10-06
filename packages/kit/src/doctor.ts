// Reports which kit version a project is on and whether the wiring is present. The package-level
// items (package.json, node_modules, eslint, tsconfig, globals.css) live in the app that owns
// package.json (`--app`, or `app` in aspira.json; the root itself for a single-app project); the
// Claude-facing items (AGENTS.md, .mcp.json, .claude/, .gitignore, aspira.json) live at the root.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appRoot, checkAspira, readApp } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { AGENTS_PACKAGE, checkSkills } from './skills.js'

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The hook command `kit init` writes: `sh <app>/node_modules/@aspiralabs/kit/hooks/<name>` from the project root. */
export const hookCommand = (app: string | undefined, name: string): string => `sh ${app ? `${app}/` : ''}node_modules/@aspiralabs/kit/hooks/${name}`

/** The MCP server entry `kit init` writes: the installed @aspiralabs/ui's server, run by node from the project root. */
export const mcpServer = (app: string): { command: string; args: string[] } => ({ command: 'node', args: [`${app}/node_modules/@aspiralabs/ui/bin/mcp.js`] })

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
  const inApp = (file: string) => (app ? `${app}/${file}` : file)
  const settings = () => JSON.stringify(readJson(join(projectRoot, '.claude', 'settings.json')) ?? {})
  const mcp = () => JSON.stringify(readJson(join(projectRoot, '.mcp.json')) ?? {})
  const ignores = (entry: string) => existsSync(join(projectRoot, '.gitignore')) && new RegExp(`^${entry.replace('.', '\\.')}/?$`, 'm').test(readFileSync(join(projectRoot, '.gitignore'), 'utf8'))
  const checks: Array<[string, () => boolean]> = [
    [`${inApp('eslint.config.mjs')} extends the kit`, () => existsSync(join(appDir, 'eslint.config.mjs')) && readFileSync(join(appDir, 'eslint.config.mjs'), 'utf8').includes('@aspiralabs/config')],
    [`${inApp('tsconfig.json')} extends the kit`, () => readJson<{ extends?: string }>(join(appDir, 'tsconfig.json'))?.extends?.includes('@aspiralabs/config') ?? false],
    [`${inApp('globals.css')} imports tokens`, () => ['app/globals.css', 'src/app/globals.css'].some((p) => existsSync(join(appDir, p)) && readFileSync(join(appDir, p), 'utf8').includes('@aspiralabs/ui/tokens.css'))],
    ['AGENTS.md has the managed block', () => existsSync(join(projectRoot, 'AGENTS.md')) && readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8').includes('aspiralabs:begin')],
    [app ? `.mcp.json registers aspiralabs-ui from ${app}/node_modules` : '.mcp.json registers aspiralabs-ui', () => mcp().includes('aspiralabs-ui') && (!app || mcp().includes(mcpServer(app).args[0]!))],
    [app ? `.claude/settings.json has the hooks from ${app}/node_modules` : '.claude/settings.json has the hooks', () => settings().includes(hookCommand(app, 'session-start.sh'))],
    ['.gitignore ignores .work/ (per-ticket working folders)', () => ignores('.work')],
    ['.gitignore ignores .aspira/ (the audit log the hooks write)', () => ignores('.aspira')],
    ['no committed feature folders (specs, docs/plans, docs/working-feature)', () => !['specs', 'docs/plans', 'docs/working-feature'].some((p) => existsSync(join(projectRoot, p)))],
  ]
  // The Feature Board: aspira.json with a Notion URL, which the skills and kit next read.
  const aspira = checkAspira(projectRoot)
  checks.push([aspira.ok ? `aspira.json names the Feature Board${app ? ` and the app (${app})` : ''}` : aspira.reason ?? 'aspira.json', () => aspira.ok])
  // The /aspira-* skills: present, complete, and from the installed @aspiralabs/agents version.
  for (const skill of checkSkills(projectRoot, app)) {
    checks.push([skill.ok ? `.claude/skills/aspira-${skill.agent} matches ${AGENTS_PACKAGE}` : skill.reason ?? `.claude/skills/aspira-${skill.agent}`, () => skill.ok])
  }
  for (const [label, ok] of checks) {
    const pass = ok()
    if (!pass) {
      problems += 1
    }
    log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }
  log(problems === 0 ? 'healthy' : `${problems} problem(s); run kit init --stack next${app ? ` --app ${app}` : ''} (and --board <Feature Board URL> when aspira.json is the problem)`)
  return problems === 0 ? 0 : 1
}
