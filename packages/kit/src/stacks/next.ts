// The Next.js profile. Each step is idempotent: run init twice, get the same project.
// Two directories: `projectRoot`, where Claude Code runs and the Claude-facing files go (AGENTS.md,
// CLAUDE.md, .mcp.json, .claude/, aspira.json, .gitignore), and the app that owns package.json and
// node_modules, where the package steps go (.npmrc, the install, eslint, prettier, tsconfig, css).
// They are the same directory unless `--app <dir>` says otherwise (apps/web in a multi-app repository).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deepMerge, readJson, writeIfAbsent, writeJson, type Log } from '../fs.js'
import { appRoot, normalizeApp, writeAspira } from '../aspira.js'
import { mcpServer } from '../doctor.js'
import { AGENTS_PACKAGE, installSkills } from '../skills.js'

export type InitOptions = { projectRoot: string; app?: string; dryRun: boolean; log: Log; board?: string; releases?: string }

/** The options with `app` normalized (undefined for the root itself) and the app directory resolved. */
type Resolved = InitOptions & { app: string | undefined; appDir: string }

const DEPS = ['@aspiralabs/ui']
const DEV_DEPS = ['@aspiralabs/config', '@aspiralabs/kit', AGENTS_PACKAGE, 'eslint', 'prettier', 'typescript']

// The kit's own version: every @aspiralabs package is installed at exactly this version, because the
// packages release in lockstep and because pnpm 12's supply-chain policy (minimum release age) would
// otherwise resolve a bare name to a version old enough to pass, not the one just released.
export const KIT_VERSION: string | undefined = readJson<{ version?: string }>(fileURLToPath(new URL('../../package.json', import.meta.url)))?.version

export function pinned(name: string, version: string | undefined): string {
  return name.startsWith('@aspiralabs/') && version ? `${name}@${version}` : name
}

const IGNORED_BUILDS = /Ignored build scripts:\s*([^\n]+)/

// pnpm 12 refuses to run a dependency's build script until the project approves it, and fails the
// install with ERR_PNPM_IGNORED_BUILDS naming the packages. pnpm itself then writes a placeholder
// into pnpm-workspace.yaml (`allowBuilds: { <name>: set this to true or false }`). Approve exactly
// the packages it named there, as `true`, and return their names.
export function approveIgnoredBuilds(output: string, workspaceYamlPath: string): string[] {
  const match = output.match(IGNORED_BUILDS)
  if (!match?.[1]) return []
  const names = [...new Set(match[1].split(',').map((entry) => entry.trim().replace(/@[^@]+$/, '')).filter(Boolean))]
  const current = existsSync(workspaceYamlPath) ? readFileSync(workspaceYamlPath, 'utf8') : ''
  writeFileSync(workspaceYamlPath, withAllowBuilds(current, names))
  return names
}

// Sets `allowBuilds: <name>: true` for each name in a pnpm-workspace.yaml, replacing pnpm's
// placeholder or an earlier value, creating the block when absent, and touching no other line.
export function withAllowBuilds(yaml: string, names: string[]): string {
  const lines = yaml === '' ? [] : yaml.replace(/\n+$/, '').split('\n')
  const start = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line))
  const entries = new Map<string, string>()
  let end = start + 1
  if (start !== -1) {
    while (end < lines.length && /^\s+\S/.test(lines[end]!)) {
      const entry = lines[end]!.match(/^\s+(['"]?)([^'":]+)\1:\s*(.*)$/)
      if (entry?.[2]) entries.set(entry[2], entry[3] ?? '')
      end += 1
    }
  }
  for (const name of names) entries.set(name, 'true')
  const block = ['allowBuilds:', ...[...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `  ${name}: ${value}`)]
  const next = start === -1 ? [...block, ...(lines.length > 0 ? ['', ...lines] : [])] : [...lines.slice(0, start), ...block, ...lines.slice(end)]
  return `${next.join('\n')}\n`
}

export function packageManager(root: string): 'pnpm' | 'npm' | 'yarn' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn'
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    return 'npm'
  }
  return 'pnpm'
}

const NPMRC = `@aspiralabs:registry=https://npm.pkg.github.com
`

// GitHub Packages needs the scope mapped (here, committed) and a token (in the
// user's ~/.npmrc, never in the project). pnpm 12 does not expand ${VAR} in
// .npmrc, so the token line cannot live in a committed file.
function npmrc(opts: Resolved): void {
  const path = join(opts.appDir, '.npmrc')
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    if (current.includes('@aspiralabs:registry')) {
      opts.log(`keep   ${path} (scope already mapped)`)
      return
    }
    opts.log(`update ${path} (map @aspiralabs to GitHub Packages)`)
    if (!opts.dryRun) {
      writeFileSync(path, `${current.trimEnd()}\n${NPMRC}`)
    }
    return
  }
  opts.log(`write  ${path}`)
  if (!opts.dryRun) {
    writeFileSync(path, NPMRC)
  }
}

function ensureToken(opts: Resolved): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const userRc = join(home, '.npmrc')
  if (existsSync(userRc) && readFileSync(userRc, 'utf8').includes('npm.pkg.github.com/:_authToken')) {
    return
  }
  opts.log('note   no GitHub Packages token in ~/.npmrc; add one line there (never in the project):')
  opts.log('       //npm.pkg.github.com/:_authToken=<classic token with read:packages>')
}

function install(opts: Resolved): void {
  ensureToken(opts)
  const pm = packageManager(opts.appDir)
  const add = pm === 'yarn' ? 'add' : pm === 'npm' ? 'install' : 'add'
  const devFlag = pm === 'npm' ? '--save-dev' : '-D'
  const cmds = [
    [pm, add, ...DEPS.map((name) => pinned(name, KIT_VERSION))],
    [pm, add, devFlag, ...DEV_DEPS.map((name) => pinned(name, KIT_VERSION))],
  ]
  for (const cmd of cmds) {
    opts.log(`run    ${cmd.join(' ')}`)
    if (opts.dryRun) {
      continue
    }
    let res = runAdd(cmd, opts.appDir)
    // Each add can surface another dependency with a build script; approve and retry, a few times at most.
    for (let attempt = 0; res.status !== 0 && pm === 'pnpm' && attempt < 5; attempt += 1) {
      const approved = approveIgnoredBuilds(res.output, join(opts.appDir, 'pnpm-workspace.yaml'))
      if (approved.length === 0) break
      opts.log(`update ${join(opts.appDir, 'pnpm-workspace.yaml')} (allowBuilds: ${approved.join(', ')})`)
      opts.log(`run    ${cmd.join(' ')} (again, with those builds approved)`)
      res = runAdd(cmd, opts.appDir)
    }
    if (res.status !== 0) {
      throw new Error(`${cmd.join(' ')} failed`)
    }
  }
}

// Runs an install command, echoing its output as it would appear, and keeps it for the build-script check.
function runAdd(cmd: string[], cwd: string): { status: number | null; output: string } {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: 'utf8' })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  process.stdout.write(output)
  return { status: res.status, output }
}

function eslint(opts: Resolved): void {
  writeIfAbsent(join(opts.appDir, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\n\nexport default next\n", opts.log, opts.dryRun)
}

function prettier(opts: Resolved): void {
  writeIfAbsent(join(opts.appDir, 'prettier.config.mjs'), "export { default } from '@aspiralabs/config/prettier'\n", opts.log, opts.dryRun)
}

function tsconfig(opts: Resolved): void {
  const path = join(opts.appDir, 'tsconfig.json')
  const current = readJson<Record<string, unknown>>(path) ?? {}
  if (current.extends === '@aspiralabs/config/tsconfig/next.json') {
    opts.log(`keep   ${path} (already extends the kit)`)
    return
  }
  const next: Record<string, unknown> = { extends: '@aspiralabs/config/tsconfig/next.json', ...current }
  next.extends = '@aspiralabs/config/tsconfig/next.json'
  // paths must live in the project: a shared tsconfig resolves them relative to itself.
  const co = (next.compilerOptions ?? {}) as Record<string, unknown>
  if (!co.paths) {
    co.paths = { '@/*': ['./*'] }
  }
  next.compilerOptions = co
  opts.log(`update ${path} (extends -> @aspiralabs/config/tsconfig/next.json)`)
  if (!opts.dryRun) {
    writeJson(path, next)
  }
}

function css(opts: Resolved): void {
  const candidates = ['app/globals.css', 'src/app/globals.css', 'styles/globals.css']
  const rel = candidates.find((c) => existsSync(join(opts.appDir, c)))
  if (!rel) {
    opts.log(`skip   globals.css not found${opts.app ? ` in ${opts.app}` : ''}; add the tokens import and @source line by hand`)
    return
  }
  const path = join(opts.appDir, rel)
  const text = readFileSync(path, 'utf8')
  if (text.includes('@aspiralabs/ui/tokens.css')) {
    opts.log(`keep   ${path} (tokens already imported)`)
    return
  }
  const depth = rel.split('/').length - 1
  const up = '../'.repeat(depth)
  const lines = [`@import "@aspiralabs/ui/tokens.css";`, `@source "${up}node_modules/@aspiralabs/ui/dist";`, `@source "${up}node_modules/@aspiralabs/ui/docs";`]
  const anchor = text.match(/^@import ['"]tailwindcss['"];?\s*$/m)
  const next = anchor ? text.replace(anchor[0], `${anchor[0]}\n${lines.join('\n')}`) : `${lines.join('\n')}\n${text}`
  opts.log(`update ${path} (tokens import + @source)`)
  if (!opts.dryRun) {
    writeFileSync(path, next)
  }
}

// The kit's own hook groups are replaced, not merged: a group from an earlier kit (the retired
// @aspiralabs/config path, or the hooks under another app directory) would otherwise stay beside
// the current one, since the merge keeps arrays. Everything else in the settings is the project's.
function dropKitHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return settings
  }
  const kit = (entry: unknown): boolean => /@aspiralabs\/(config\/agent|kit)\/hooks\//.test(JSON.stringify(entry))
  const next: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    next[event] = Array.isArray(groups) ? groups.filter((g) => !kit(g)) : groups
  }
  return { ...settings, hooks: next }
}

function agentFiles(opts: Resolved): void {
  // Templates ship with this package (templates/agent/), so a project gets the version of the kit it installed.
  // `{{app}}` is the app directory with a trailing slash, or nothing: the paths in the written files are
  // relative to the project root, where Claude Code runs them.
  const templatesDir = fileURLToPath(new URL('../../templates/agent/', import.meta.url))
  const appPrefix = opts.app ? `${opts.app}/` : ''
  const appLine = opts.app ? `- **The app:** \`${opts.app}\` owns \`package.json\` and \`node_modules\`; run package commands (install, lint, test, check) there. Claude Code runs at this root.\n` : ''
  const tpl = (name: string, fallback: string): string => {
    const p = join(templatesDir, name)
    return (existsSync(p) ? readFileSync(p, 'utf8') : fallback).replaceAll('{{app}}', appPrefix).replaceAll('{{app-line}}\n', appLine)
  }
  const project = basename(opts.projectRoot)

  // AGENTS.md: managed block is replaced, everything outside it is kept.
  const agentsPath = join(opts.projectRoot, 'AGENTS.md')
  const template = tpl('AGENTS.md', `# ${project}\n\n<!-- aspiralabs:begin -->\nThis project is on the Aspira Labs kit.\n<!-- aspiralabs:end -->\n`).replace('{{project}}', project)
  const block = template.match(/<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/)?.[0] ?? ''
  if (existsSync(agentsPath)) {
    const current = readFileSync(agentsPath, 'utf8')
    const next = /<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/.test(current)
      ? current.replace(/<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/, block)
      : `${current.trimEnd()}\n\n${block}\n`
    opts.log(next === current ? `keep   ${agentsPath} (managed block current)` : `update ${agentsPath} (managed block)`)
    if (!opts.dryRun && next !== current) {
      writeFileSync(agentsPath, next)
    }
  } else {
    opts.log(`write  ${agentsPath}`)
    if (!opts.dryRun) {
      writeFileSync(agentsPath, template)
    }
  }

  writeIfAbsent(join(opts.projectRoot, 'CLAUDE.md'), tpl('CLAUDE.md', '@AGENTS.md\n'), opts.log, opts.dryRun)

  // .mcp.json: the aspiralabs-ui entry is the kit's and is replaced whole (npx finds the bin from the
  // root's node_modules; with an app, node runs the installed package's server from the app's). The
  // project's other servers are kept.
  const mcpPath = join(opts.projectRoot, '.mcp.json')
  const mcpTemplate = JSON.parse(tpl('mcp.json', '{"mcpServers":{"aspiralabs-ui":{"command":"npx","args":["--no","aspiralabs-ui-mcp"]}}}')) as { mcpServers: Record<string, unknown> }
  if (opts.app) mcpTemplate.mcpServers['aspiralabs-ui'] = mcpServer(opts.app)
  const mcpCurrent = readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath) ?? {}
  const mcpNext = deepMerge({ ...mcpCurrent, mcpServers: { ...mcpCurrent.mcpServers, 'aspiralabs-ui': undefined } }, mcpTemplate)
  opts.log(`${existsSync(mcpPath) ? 'update' : 'write '} ${mcpPath} (aspiralabs-ui server${opts.app ? ` from ${opts.app}/node_modules` : ''})`)
  if (!opts.dryRun) {
    writeJson(mcpPath, mcpNext)
  }

  const settingsPath = join(opts.projectRoot, '.claude', 'settings.json')
  const settingsTemplate = JSON.parse(tpl('claude-settings.json', '{}')) as Record<string, unknown>
  const settingsNext = deepMerge(dropKitHooks(readJson<Record<string, unknown>>(settingsPath) ?? {}), settingsTemplate)
  opts.log(`${existsSync(settingsPath) ? 'update' : 'write '} ${settingsPath} (session-start, deny-tier3, audit-log hooks${opts.app ? ` from ${opts.app}/node_modules` : ''})`)
  if (!opts.dryRun) {
    writeJson(settingsPath, settingsNext)
  }
}

/** The entries kit init adds to the root .gitignore, each with the comment above it. */
export const GITIGNORE_ENTRIES: ReadonlyArray<readonly [entry: string, comment: string]> = [
  ['.work/', '# per-ticket working folders (pulled from the Notion ticket, never committed)'],
  ['.aspira/', "# the audit log the kit's hooks write (.aspira/audit.jsonl)"],
]

function gitignore(opts: Resolved): void {
  // Per-ticket working folders are pulled from the Notion ticket and never committed; the audit log
  // the hooks write at the root would otherwise dirty the tree on the first tool call.
  const path = join(opts.projectRoot, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const missing = GITIGNORE_ENTRIES.filter(([entry]) => !new RegExp(`^${entry.replace('.', '\\.').replace(/\/$/, '')}/?$`, 'm').test(current))
  if (missing.length === 0) {
    opts.log(`keep   ${path} (${GITIGNORE_ENTRIES.map(([entry]) => entry).join(', ')} ignored)`)
    return
  }
  opts.log(`update ${path} (ignore ${missing.map(([entry]) => entry).join(', ')})`)
  if (!opts.dryRun) {
    writeFileSync(path, `${current.trimEnd()}${current ? '\n\n' : ''}${missing.map(([entry, comment]) => `${comment}\n${entry}\n`).join('')}`)
  }
}

export async function initNext(options: InitOptions): Promise<void> {
  const app = options.app === undefined ? undefined : normalizeApp(options.app)
  const opts: Resolved = { ...options, app: app === '.' ? undefined : app, appDir: appRoot(options.projectRoot, app) }
  if (opts.app && !existsSync(join(opts.appDir, 'package.json'))) {
    throw new Error(`--app ${opts.app}: no package.json in ${opts.appDir}; --app names the directory that owns package.json and node_modules, relative to ${opts.projectRoot}`)
  }
  opts.log(`stack  next (${opts.projectRoot}${opts.app ? `; app ${opts.app}` : ''})`)
  npmrc(opts)
  install(opts)
  eslint(opts)
  prettier(opts)
  tsconfig(opts)
  css(opts)
  agentFiles(opts)
  // The /aspira-* skills, copied from the installed agent packages (under the app) into the root and pinned to their version.
  installSkills({ projectRoot: opts.projectRoot, app: opts.app, dryRun: opts.dryRun, log: opts.log })
  gitignore(opts)
  // The Feature Board the skills and kit next read, when the project has one, and the app the launchers and kit next resolve the packages under.
  writeAspira({ projectRoot: opts.projectRoot, board: opts.board, releases: opts.releases, app: opts.app, dryRun: opts.dryRun, log: opts.log })
  opts.log(`done   run \`pnpm lint\`${opts.app ? ` in ${opts.app}` : ''} to see what the org rules think of the codebase`)
}
