// The Next.js profile. Each step is idempotent: run init twice, get the same project.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deepMerge, readJson, writeIfAbsent, writeJson, type Log } from '../fs.js'
import { writeAspira } from '../aspira.js'
import { AGENTS_PACKAGE, installSkills } from '../skills.js'

export type InitOptions = { projectRoot: string; dryRun: boolean; log: Log; board?: string; releases?: string }

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
// install with ERR_PNPM_IGNORED_BUILDS naming the packages. Approve exactly those in the project's
// pnpm-workspace.yaml `onlyBuiltDependencies` (pnpm 12 no longer reads the `pnpm` field of
// package.json), merged with what is there, and return their names.
export function approveIgnoredBuilds(output: string, workspaceYamlPath: string): string[] {
  const match = output.match(IGNORED_BUILDS)
  if (!match?.[1]) return []
  const names = [...new Set(match[1].split(',').map((entry) => entry.trim().replace(/@[^@]+$/, '')).filter(Boolean))]
  const current = existsSync(workspaceYamlPath) ? readFileSync(workspaceYamlPath, 'utf8') : ''
  writeFileSync(workspaceYamlPath, withOnlyBuiltDependencies(current, names))
  return names
}

// Adds names to the `onlyBuiltDependencies` list of a pnpm-workspace.yaml, creating the list when
// absent and leaving every other line untouched. The list is kept sorted and unique.
export function withOnlyBuiltDependencies(yaml: string, names: string[]): string {
  const lines = yaml === '' ? [] : yaml.replace(/\n+$/, '').split('\n')
  const start = lines.findIndex((line) => /^onlyBuiltDependencies:\s*$/.test(line))
  const existing: string[] = []
  let end = start + 1
  if (start !== -1) {
    while (end < lines.length && /^\s+-\s+/.test(lines[end]!)) {
      existing.push(lines[end]!.replace(/^\s+-\s+/, '').replace(/^['"]|['"]$/g, '').trim())
      end += 1
    }
  }
  const merged = [...new Set([...existing, ...names])].sort()
  const block = ['onlyBuiltDependencies:', ...merged.map((name) => `  - ${name}`)]
  const next = start === -1 ? [...lines, ...(lines.length > 0 ? [''] : []), ...block] : [...lines.slice(0, start), ...block, ...lines.slice(end)]
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
function npmrc(opts: InitOptions): void {
  const path = join(opts.projectRoot, '.npmrc')
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

function ensureToken(opts: InitOptions): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const userRc = join(home, '.npmrc')
  if (existsSync(userRc) && readFileSync(userRc, 'utf8').includes('npm.pkg.github.com/:_authToken')) {
    return
  }
  opts.log('note   no GitHub Packages token in ~/.npmrc; add one line there (never in the project):')
  opts.log('       //npm.pkg.github.com/:_authToken=<classic token with read:packages>')
}

function install(opts: InitOptions): void {
  ensureToken(opts)
  const pm = packageManager(opts.projectRoot)
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
    let res = runAdd(cmd, opts.projectRoot)
    if (res.status !== 0 && pm === 'pnpm') {
      const approved = approveIgnoredBuilds(res.output, join(opts.projectRoot, 'pnpm-workspace.yaml'))
      if (approved.length > 0) {
        opts.log(`update ${join(opts.projectRoot, 'pnpm-workspace.yaml')} (onlyBuiltDependencies += ${approved.join(', ')})`)
        opts.log(`run    ${cmd.join(' ')} (again, with those builds approved)`)
        res = runAdd(cmd, opts.projectRoot)
      }
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

function eslint(opts: InitOptions): void {
  writeIfAbsent(join(opts.projectRoot, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\n\nexport default next\n", opts.log, opts.dryRun)
}

function prettier(opts: InitOptions): void {
  writeIfAbsent(join(opts.projectRoot, 'prettier.config.mjs'), "export { default } from '@aspiralabs/config/prettier'\n", opts.log, opts.dryRun)
}

function tsconfig(opts: InitOptions): void {
  const path = join(opts.projectRoot, 'tsconfig.json')
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

function css(opts: InitOptions): void {
  const candidates = ['app/globals.css', 'src/app/globals.css', 'styles/globals.css']
  const rel = candidates.find((c) => existsSync(join(opts.projectRoot, c)))
  if (!rel) {
    opts.log('skip   globals.css not found; add the tokens import and @source line by hand')
    return
  }
  const path = join(opts.projectRoot, rel)
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

// Hooks used to live in @aspiralabs/config; a project wired before that still names them, and the merge keeps arrays.
function dropRetiredHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return settings
  }
  const retired = (entry: unknown): boolean => JSON.stringify(entry).includes('@aspiralabs/config/agent/hooks/')
  const next: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    next[event] = Array.isArray(groups) ? groups.filter((g) => !retired(g)) : groups
  }
  return { ...settings, hooks: next }
}

function agentFiles(opts: InitOptions): void {
  // Templates ship with this package (templates/agent/), so a project gets the version of the kit it installed.
  const templatesDir = fileURLToPath(new URL('../../templates/agent/', import.meta.url))
  const tpl = (name: string, fallback: string): string => {
    const p = join(templatesDir, name)
    return existsSync(p) ? readFileSync(p, 'utf8') : fallback
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

  const mcpPath = join(opts.projectRoot, '.mcp.json')
  const mcpTemplate = JSON.parse(tpl('mcp.json', '{"mcpServers":{"aspiralabs-ui":{"command":"npx","args":["--no","aspiralabs-ui-mcp"]}}}')) as Record<string, unknown>
  const mcpNext = deepMerge(readJson<Record<string, unknown>>(mcpPath) ?? {}, mcpTemplate)
  opts.log(`${existsSync(mcpPath) ? 'update' : 'write '} ${mcpPath} (aspiralabs-ui server)`)
  if (!opts.dryRun) {
    writeJson(mcpPath, mcpNext)
  }

  const settingsPath = join(opts.projectRoot, '.claude', 'settings.json')
  const settingsTemplate = JSON.parse(tpl('claude-settings.json', '{}')) as Record<string, unknown>
  const settingsNext = deepMerge(dropRetiredHooks(readJson<Record<string, unknown>>(settingsPath) ?? {}), settingsTemplate)
  opts.log(`${existsSync(settingsPath) ? 'update' : 'write '} ${settingsPath} (session-start, deny-tier3, audit-log hooks)`)
  if (!opts.dryRun) {
    writeJson(settingsPath, settingsNext)
  }
}

function gitignore(opts: InitOptions): void {
  // Per-ticket working folders are pulled from the Notion ticket and never committed.
  const path = join(opts.projectRoot, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (/^\.work\/?$/m.test(current)) {
    opts.log(`keep   ${path} (.work/ ignored)`)
    return
  }
  opts.log(`update ${path} (ignore .work/)`)
  if (!opts.dryRun) {
    writeFileSync(path, `${current.trimEnd()}${current ? '\n\n' : ''}# per-ticket working folders (pulled from the Notion ticket, never committed)\n.work/\n`)
  }
}

export async function initNext(opts: InitOptions): Promise<void> {
  opts.log(`stack  next (${opts.projectRoot})`)
  npmrc(opts)
  install(opts)
  eslint(opts)
  prettier(opts)
  tsconfig(opts)
  css(opts)
  agentFiles(opts)
  // The /aspira-* skills, copied from the installed agent packages and pinned to their version.
  installSkills(opts)
  gitignore(opts)
  // The Feature Board the skills and kit next read, when the project has one.
  writeAspira({ projectRoot: opts.projectRoot, board: opts.board, releases: opts.releases, dryRun: opts.dryRun, log: opts.log })
  opts.log('done   run `pnpm lint` to see what the org rules think of the codebase')
}
