// The Next.js profile. Each step is idempotent: run init twice, get the same project.
// Two directories: `projectRoot`, where Claude Code runs and the Claude-facing files go (AGENTS.md,
// CLAUDE.md, .mcp.json, .claude/, aspira.json, .gitignore), and the app that owns package.json and
// node_modules, where the package steps go (.npmrc, the install, eslint, prettier, tsconfig, css).
// They are the same directory unless `--app <dir>` says otherwise (apps/web in a multi-app repository).
// With `--app` there are two layouts. In a repository with no root package.json, the app is on its own
// and gets every package file. In a workspace (pnpm, npm or yarn) whose root has its own package.json,
// the registry mapping, the lockfile, allowBuilds and a shared prettier config belong to the root:
// init uses the root's and writes none into the app, and keeps @aspiralabs packages the root already
// declares on the same version as the app's.
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, basename, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deepMerge, hasJsonComments, readJson, writeIfAbsent, writeJson, type Log } from '../fs.js'
import { appRoot, isWorkspaceRoot, normalizeApp, readAspira, writeAspira } from '../aspira.js'
import { ENV_DEVELOPMENT_ENTRY, ENV_LOCAL_ENTRY, envDevelopmentIgnored, envLocalIgnored, gitRootOf, hasLine, isolates, mcpServer, WORKTREES_ENTRY } from '../doctor.js'
import { AGENTS, AI_PACKAGE, HOOKS_DIR, KIT_SKILLS, RETIRED_SKILLS, VERSION_FILE } from '../skills.js'

export type InitOptions = { projectRoot: string; app?: string; dryRun: boolean; log: Log; board?: string; releases?: string }

/** The options with `app` normalized (undefined for the root itself), the app directory resolved, and
 * `workspaceDir`: the directory that owns the lockfile and .npmrc (the root of a workspace, else the app). */
type Resolved = InitOptions & { app: string | undefined; appDir: string; workspace: boolean; workspaceDir: string }

const DEPS = ['@aspiralabs/ui']
// @aspiralabs/ai is not among them: it is installed globally, once per engineer (pnpm add -g @aspiralabs/ai).
const DEV_DEPS = ['@aspiralabs/config', 'eslint', 'prettier', 'typescript']

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

/**
 * The directory that owns the lockfile and .npmrc, where install and build run: the project root when
 * the app sits in a workspace rooted there (isWorkspaceRoot), else the app's own directory.
 */
export function workspaceDirOf(projectRoot: string, app: string | undefined): string {
  return isWorkspaceRoot(projectRoot, app) ? projectRoot : appRoot(projectRoot, app)
}

/** The package manager whose lockfile is in `root`: pnpm, yarn or npm, and pnpm when there is none. */
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
  // pnpm and npm read a workspace's registry settings from its root .npmrc, not the app's.
  const path = join(opts.workspaceDir, '.npmrc')
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
  const pm = packageManager(opts.workspaceDir)
  for (const [cmd, cwd] of installCommands(opts, pm)) {
    opts.log(`run    ${cmd.join(' ')}${opts.workspace ? ` (in ${cwd === opts.projectRoot ? 'the workspace root' : opts.app})` : ''}`)
    if (opts.dryRun) {
      continue
    }
    let res = runAdd(cmd, cwd)
    // Each add can surface another dependency with a build script; approve and retry, a few times at most.
    for (let attempt = 0; res.status !== 0 && pm === 'pnpm' && attempt < 5; attempt += 1) {
      const approved = approveIgnoredBuilds(res.output, join(opts.workspaceDir, 'pnpm-workspace.yaml'))
      if (approved.length === 0) break
      opts.log(`update ${join(opts.workspaceDir, 'pnpm-workspace.yaml')} (allowBuilds: ${approved.join(', ')})`)
      opts.log(`run    ${cmd.join(' ')} (again, with those builds approved)`)
      res = runAdd(cmd, cwd)
    }
    if (res.status !== 0) {
      throw new Error(`${cmd.join(' ')} failed`)
    }
  }
}

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const declares = (pkg: Pkg | undefined, name: string): boolean => pkg?.dependencies?.[name] !== undefined || pkg?.devDependencies?.[name] !== undefined

/**
 * The install commands for the app, then, in a workspace, for the @aspiralabs packages the root already declares (kept on the
 * app's version). A project copy of @aspiralabs/ai an earlier kit added is removed first, from the app and the workspace root:
 * it would win over the global install.
 */
function installCommands(opts: Resolved, pm: 'pnpm' | 'npm' | 'yarn'): Array<[cmd: string[], cwd: string]> {
  const add = pm === 'npm' ? 'install' : 'add'
  const remove = pm === 'npm' ? 'uninstall' : 'remove'
  const devFlag = pm === 'npm' ? '--save-dev' : '-D'
  // pnpm and yarn refuse an add at a workspace root without saying it is meant (-w, -W).
  const rootFlag = pm === 'pnpm' ? ['-w'] : pm === 'yarn' ? ['-W'] : []
  const root = opts.workspace ? (readJson<Pkg>(join(opts.projectRoot, 'package.json')) ?? {}) : undefined
  const cmds: Array<[string[], string]> = []
  if (declares(readJson<Pkg>(join(opts.appDir, 'package.json')), AI_PACKAGE)) cmds.push([[pm, remove, AI_PACKAGE], opts.appDir])
  if (declares(root, AI_PACKAGE)) cmds.push([[pm, remove, ...rootFlag, AI_PACKAGE], opts.projectRoot])
  cmds.push([[pm, add, ...DEPS.map((name) => pinned(name, KIT_VERSION))], opts.appDir], [[pm, add, devFlag, ...DEV_DEPS.map((name) => pinned(name, KIT_VERSION))], opts.appDir])
  if (root === undefined) return cmds
  const kitNames = (deps: Record<string, string> | undefined) => Object.keys(deps ?? {}).filter((name) => name.startsWith('@aspiralabs/') && name !== AI_PACKAGE)
  const deps = kitNames(root.dependencies)
  const devDeps = kitNames(root.devDependencies)
  if (deps.length > 0) cmds.push([[pm, add, ...rootFlag, ...deps.map((name) => pinned(name, KIT_VERSION))], opts.projectRoot])
  if (devDeps.length > 0) cmds.push([[pm, add, ...rootFlag, devFlag, ...devDeps.map((name) => pinned(name, KIT_VERSION))], opts.projectRoot])
  return cmds
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

// The config files prettier looks for, nearest first; a workspace root's one applies to the app too.
const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.js', '.prettierrc.mjs', '.prettierrc.cjs', '.prettierrc.ts', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs', 'prettier.config.ts', 'prettier.config.mts', 'prettier.config.cts']

function prettierConfig(dir: string): string | undefined {
  const file = PRETTIER_CONFIGS.find((name) => existsSync(join(dir, name)))
  if (file) return file
  return readJson<{ prettier?: unknown }>(join(dir, 'package.json'))?.prettier === undefined ? undefined : 'package.json "prettier"'
}

function prettier(opts: Resolved): void {
  const shared = opts.workspace && !prettierConfig(opts.appDir) ? prettierConfig(opts.projectRoot) : undefined
  if (shared) {
    opts.log(`keep   ${join(opts.projectRoot, shared)} (the workspace root's prettier config covers ${opts.app})`)
    return
  }
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
  opts.log(`update ${path} (extends -> @aspiralabs/config/tsconfig/next.json${hasJsonComments(path) ? '; its comments are not kept, put them back by hand' : ''})`)
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

// The kit's own hook commands are removed before the template's are added, not merged: a command from an
// earlier kit (the retired @aspiralabs/config path, the hooks under node_modules, or a project's
// .claude/hooks/aspira) would otherwise stay beside the current one, since the merge keeps arrays. Only the
// kit's commands go: a group's other commands are the engineer's, a group left empty is dropped, and so is
// an event left empty. The global writer and the leftover removal share this matcher.
export function dropKitHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return settings
  }
  const kit = (entry: unknown): boolean => /@aspiralabs\/(config\/agent|kit|ai)\/hooks\/|\.claude\/hooks\/aspira\//.test(JSON.stringify(entry))
  const next: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      next[event] = groups
      continue
    }
    const kept: unknown[] = []
    for (const group of groups as unknown[]) {
      const inner = group !== null && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : undefined
      if (!Array.isArray(inner)) {
        if (!kit(group)) kept.push(group)
        continue
      }
      const left = inner.filter((hook) => !kit(hook))
      if (left.length === inner.length) kept.push(group)
      else if (left.length > 0) kept.push({ ...(group as object), hooks: left })
    }
    if (kept.length > 0 || groups.length === 0) next[event] = kept
  }
  const { hooks: _dropped, ...rest } = settings
  return Object.keys(next).length > 0 ? { ...rest, hooks: next } : rest
}

function agentFiles(opts: Resolved): void {
  // Templates ship with this package (templates/agent/), so a project gets the version of the kit it installed.
  // `{{app}}` is the app directory with a trailing slash, or nothing: the paths in the written files are
  // relative to the project root, where Claude Code runs them.
  const templatesDir = fileURLToPath(new URL('../../templates/agent/', import.meta.url))
  const appPrefix = opts.app ? `${opts.app}/` : ''
  const tpl = (name: string, fallback: string): string => {
    const p = join(templatesDir, name)
    return (existsSync(p) ? readFileSync(p, 'utf8') : fallback).replaceAll('{{app}}', appPrefix)
  }
  const project = basename(opts.projectRoot)

  // AGENTS.md is the project's own: written from the template when absent (no harness in it), never touched after.
  const agentsPath = join(opts.projectRoot, 'AGENTS.md')
  if (existsSync(agentsPath)) {
    opts.log(`keep   ${agentsPath} (the project's own)`)
  } else {
    opts.log(`write  ${agentsPath}`)
    if (!opts.dryRun) {
      writeFileSync(agentsPath, tpl('AGENTS.md', `# ${project}\n\n## About this project\n\n## Gotchas\n`).replace('{{project}}', project))
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
}

/** The ignore lines an earlier kit wrote into .gitignore, each with the comment above it; the global ignore holds them now, so init removes them. */
export const gitignoreEntries = (): ReadonlyArray<readonly [entry: string, comment: string]> => [
  ['.work/', '# per-ticket working folders (pulled from the Notion ticket, never committed)'],
  ['.aspira/', "# the audit log the kit's hooks write (.aspira/audit.jsonl)"],
  [WORKTREES_ENTRY[0], WORKTREES_ENTRY[1]],
]

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** Appends each entry, with its comment above it, to the .gitignore at `path`, after a blank line when it has content. */
function appendIgnore(path: string, current: string, entries: ReadonlyArray<readonly [string, string]>, opts: Resolved): void {
  opts.log(`update ${path} (ignore ${entries.map(([entry]) => entry).join(', ')})`)
  if (!opts.dryRun) {
    writeFileSync(path, `${current.trimEnd()}${current ? '\n\n' : ''}${entries.map(([entry, comment]) => `${comment}\n${entry}\n`).join('')}`)
  }
}

function gitignore(opts: Resolved): void {
  // The harness ignore lines (.work/, .aspira/, .worktrees/) are in the global git ignore. The project's own
  // .gitignore keeps the secrets kit worktree links: .env.local unless git already ignores every linked copy,
  // through a glob such as .env*.local. Outside a git repository neither applies.
  const path = join(opts.projectRoot, '.gitignore')
  const current = readText(path)
  const wanted: Array<readonly [string, string]> = []
  const missing: Array<readonly [string, string]> = []
  const gitRoot = gitRootOf(opts.projectRoot)
  if (gitRoot === undefined) {
    opts.log(`skip   ${ENV_LOCAL_ENTRY[0]} ignore line (not in a git repository)`)
  } else {
    if (hasLine(current, ENV_LOCAL_ENTRY[0]) || !envLocalIgnored(opts.projectRoot, opts.app)) {
      wanted.push(ENV_LOCAL_ENTRY)
      if (!hasLine(current, ENV_LOCAL_ENTRY[0])) missing.push(ENV_LOCAL_ENTRY)
    }
    // The per-worktree file kit worktree writes (database URL, port, webhook secrets), only for a project that isolates.
    if (isolates(readAspira(opts.projectRoot)) && (hasLine(current, ENV_DEVELOPMENT_ENTRY[0]) || !envDevelopmentIgnored(opts.projectRoot, opts.app))) {
      wanted.push(ENV_DEVELOPMENT_ENTRY)
      if (!hasLine(current, ENV_DEVELOPMENT_ENTRY[0])) missing.push(ENV_DEVELOPMENT_ENTRY)
    }
  }
  if (missing.length === 0) {
    if (wanted.length > 0) opts.log(`keep   ${path} (${wanted.map(([entry]) => entry).join(', ')} ignored)`)
    return
  }
  appendIgnore(path, current, missing, opts)
}

/** One thing an earlier kit left in a project's working tree: where it is (absolute), what to call it, and how to remove it. */
export type Leftover = { path: string; label: string; remove: () => void }

const MANAGED_BLOCK = /<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/

const isFolder = (path: string): boolean => {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** `text` without the given kit ignore lines, each with the comment directly above it when that comment is the kit's own words. */
function withoutKitIgnores(text: string, entries: ReadonlyArray<readonly [string, string]>): string {
  const lines = text.split('\n')
  const drop = new Set<number>()
  lines.forEach((line, index) => {
    const found = entries.find(([entry]) => line.trimEnd() === entry || line.trimEnd() === entry.replace(/\/$/, ''))
    if (found === undefined) return
    drop.add(index)
    if (index > 0 && lines[index - 1]!.trimEnd() === found[1]) drop.add(index - 1)
  })
  return lines.filter((_, index) => !drop.has(index)).join('\n')
}

const kitIgnoresIn = (text: string, entries: ReadonlyArray<readonly [string, string]>): string[] => entries.filter(([entry]) => withoutKitIgnores(text, [[entry, '']]) !== text).map(([entry]) => entry)

/**
 * What an earlier kit committed into the project and the working tree still holds: the kit's skill folders (those carrying
 * .kit-version), .claude/hooks/aspira/, the kit's hook commands in .claude/settings.json, the managed block in AGENTS.md, and the
 * .work/, .aspira/ and .worktrees/ ignore lines (the git root's .gitignore too, for a project below it, for .worktrees/). Read from
 * the files only, never from git's index. `kit init` removes them (removeHarness); `kit doctor` reports them.
 */
export function harnessLeftovers(projectRoot: string): Leftover[] {
  const out: Leftover[] = []
  const rel = (path: string): string => relative(projectRoot, path) || '.'
  const skills = join(projectRoot, '.claude', 'skills')
  for (const name of [...AGENTS, ...KIT_SKILLS, ...RETIRED_SKILLS]) {
    const dir = join(skills, `aspira-${name}`)
    if (isFolder(dir) && existsSync(join(dir, VERSION_FILE))) out.push({ path: dir, label: rel(dir), remove: () => rmSync(dir, { recursive: true, force: true }) })
  }
  const hooks = join(projectRoot, HOOKS_DIR)
  if (isFolder(hooks)) out.push({ path: hooks, label: rel(hooks), remove: () => rmSync(hooks, { recursive: true, force: true }) })
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  const settings = readJson<Record<string, unknown>>(settingsPath)
  if (settings !== undefined) {
    const kept = dropKitHooks(settings)
    if (JSON.stringify(kept) !== JSON.stringify(settings)) {
      out.push({
        path: settingsPath,
        label: `${rel(settingsPath)} (the kit's hook commands)`,
        remove: () => {
          if (Object.keys(kept).length === 0) rmSync(settingsPath)
          else writeJson(settingsPath, kept)
        },
      })
    }
  }
  const agentsPath = join(projectRoot, 'AGENTS.md')
  if (MANAGED_BLOCK.test(readText(agentsPath))) {
    out.push({ path: agentsPath, label: `${rel(agentsPath)} (the aspiralabs managed block)`, remove: () => writeFileSync(agentsPath, readText(agentsPath).replace(MANAGED_BLOCK, '')) })
  }
  const gitRoot = gitRootOf(projectRoot)
  const ignoreFiles: Array<[string, ReadonlyArray<readonly [string, string]>]> = [[join(projectRoot, '.gitignore'), gitignoreEntries()]]
  if (gitRoot !== undefined && gitRoot !== projectRoot) ignoreFiles.push([join(gitRoot, '.gitignore'), [WORKTREES_ENTRY]])
  for (const [path, entries] of ignoreFiles) {
    const found = kitIgnoresIn(readText(path), entries)
    if (found.length === 0) continue
    out.push({
      path,
      label: `${rel(path)} (still lists ${found.join(', ')}; the global ignore does that now)`,
      remove: () => writeFileSync(path, withoutKitIgnores(readText(path), entries)),
    })
  }
  return out
}

/** The path as printed in a git command: relative to the project root, quoted when it has a space. */
const gitPath = (projectRoot: string, path: string): string => {
  const shown = relative(projectRoot, path) || '.'
  return /\s/.test(shown) ? `'${shown}'` : shown
}

/**
 * Removes the harness an earlier kit committed into the project (harnessLeftovers); the global harness replaces it. A dry run only
 * lists. After a removal it prints the `git add` and `git commit` that record it, limited to the removed and edited paths, and
 * commits nothing; with nothing to remove it prints no commit command.
 */
function removeHarness(opts: Resolved): void {
  const leftovers = harnessLeftovers(opts.projectRoot)
  if (leftovers.length === 0) {
    opts.log('keep   nothing to remove (no committed Aspira harness in the project)')
    return
  }
  for (const item of leftovers) {
    opts.log(`remove ${item.label}`)
    if (!opts.dryRun) item.remove()
  }
  if (opts.dryRun) return
  for (const dir of [join(opts.projectRoot, '.claude', 'skills'), join(opts.projectRoot, '.claude', 'hooks')]) {
    if (isFolder(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  }
  const paths = leftovers.map((item) => gitPath(opts.projectRoot, item.path)).join(' ')
  opts.log('note   the global harness replaces these files; record the removal (init commits nothing):')
  opts.log(`       git add -A -- ${paths}`)
  opts.log(`       git commit -m "chore: remove the committed Aspira harness" -- ${paths}`)
}

export async function initNext(options: InitOptions): Promise<void> {
  const app = options.app === undefined ? undefined : normalizeApp(options.app)
  const appDir = appRoot(options.projectRoot, app)
  const workspace = isWorkspaceRoot(options.projectRoot, app)
  const opts: Resolved = { ...options, app: app === '.' ? undefined : app, appDir, workspace, workspaceDir: workspaceDirOf(options.projectRoot, app) }
  if (opts.app && !existsSync(join(opts.appDir, 'package.json'))) {
    throw new Error(`--app ${opts.app}: no package.json in ${opts.appDir}; --app names the directory that owns package.json and node_modules, relative to ${opts.projectRoot}`)
  }
  opts.log(`stack  next (${opts.projectRoot}${opts.app ? `; app ${opts.app}${workspace ? ' in the workspace' : ''}` : ''})`)
  npmrc(opts)
  install(opts)
  eslint(opts)
  prettier(opts)
  tsconfig(opts)
  css(opts)
  agentFiles(opts)
  // The /aspira-* skills and hooks are global (~/.claude, written by `kit`); an earlier kit's copies in the project are removed.
  removeHarness(opts)
  gitignore(opts)
  // The Feature Board the skills and kit next read, when the project has one, and the app the launchers and kit next resolve the packages under.
  writeAspira({ projectRoot: opts.projectRoot, board: opts.board, releases: opts.releases, app: opts.app, dryRun: opts.dryRun, log: opts.log })
  opts.log(`done   run \`pnpm lint\`${opts.app ? ` in ${opts.app}` : ''} to see what the org rules think of the codebase`)
}
