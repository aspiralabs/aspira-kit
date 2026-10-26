// The /aspira-* skills and the hooks that go with them: eight agent skills and three kit launchers, all
// from one package, @aspiralabs/ai. Each agent ships its skill under <agent>/skill/aspira-<agent>/ and the
// kit skills sit under skills/aspira-<name>/ (SKILL.md and scripts/<name>.sh). They are a global harness,
// written once per engineer into ~/.claude (skills/aspira-<name>/, hooks/aspira/, and the kit's hook groups
// in settings.json) plus three lines in the global git ignore, never into a project. Each skill is stamped
// with the running kit's version in .kit-version; `kit` rewrites the harness before any command when
// harnessCurrent finds it stale, and `kit doctor` reports the same items.
// @aspiralabs/ai is installed globally (pnpm add -g), so the source is always the running kit's own package;
// a copy under a project's node_modules is never consulted.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, type Log } from './fs.js'
import { dropKitHooks } from './stacks/next.js'

/** The agents a project gets through @aspiralabs/ai, each with a /aspira-<agent> skill. */
export const AGENTS = ['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'build-feature', 'visual-verify'] as const
/** Skills an earlier kit installed that no longer exist: `kit init` removes their folders (spec-reviewer folded into spec-writer, KIT-48). */
export const RETIRED_SKILLS = ['spec-reviewer'] as const
export type Agent = (typeof AGENTS)[number]

/** The skills @aspiralabs/ai ships for the kit itself, each a /aspira-<name> launcher for `kit <name>`. */
export const KIT_SKILLS = ['cleanup', 'next', 'worktree'] as const
export type KitSkill = (typeof KIT_SKILLS)[number]

/** Any /aspira-* skill kit installs: an agent's or one of the kit's own. */
export type SkillName = Agent | KitSkill

/** The one package that brings the kit, every agent and all eleven skills into a project. */
export const AI_PACKAGE = '@aspiralabs/ai'
/** Where a skill records the kit version it was installed from. */
export const VERSION_FILE = '.kit-version'

/** This kit package's own directory (the parent of src/ or dist/), where skills/ ships. */
const KIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** The home folder the harness is written under: `home` when given, else the user's. */
const homeOf = (home?: string): string => home ?? homedir()

/** <home>/.claude/skills/aspira-<name>/, the global skill folder. */
export const skillDir = (home: string, name: SkillName | (typeof RETIRED_SKILLS)[number]): string => join(home, '.claude', 'skills', `aspira-${name}`)

/** The kit-owned skill's source folder in this kit package. */
export const kitSkillDir = (name: KitSkill): string => join(KIT_DIR, 'skills', `aspira-${name}`)

const isPackage = (dir: string, name: string): boolean => readJson<{ name?: string }>(join(dir, 'package.json'))?.name === name

/** This kit package's directory: the global @aspiralabs/ai `kit` runs from (or the source checkout). `kit package-dir` prints it for the launchers. */
export const kitPackageDir = (): string => KIT_DIR

/** The @aspiralabs/ai the kit runs from: the running kit's own package, the global install. A copy in a project's node_modules is never used. */
export function aiPackageDir(): string | undefined {
  return isPackage(KIT_DIR, AI_PACKAGE) ? KIT_DIR : undefined
}

/** The version of the running @aspiralabs/ai (see aiPackageDir), or undefined. */
export function aiVersion(): string | undefined {
  const dir = aiPackageDir()
  return dir === undefined ? undefined : readJson<{ version?: string }>(join(dir, 'package.json'))?.version
}

/** The version of this kit package, the one its own skills are stamped with. */
const ownKitVersion = (): string | undefined => readJson<{ version?: string }>(join(KIT_DIR, 'package.json'))?.version

/** Every file under `dir`, relative, sorted, with its contents. */
function tree(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      for (const [k, v] of tree(dir, rel)) out.set(k, v)
    } else if (entry.isFile()) {
      out.set(rel, readFileSync(join(dir, rel)))
    }
  }
  return out
}

function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const other = b.get(k)
    if (other === undefined || !v.equals(other)) return false
  }
  return true
}


/** The hooks the kit ships in hooks/, written to ~/.claude/hooks/aspira/; ~/.claude/settings.json runs them from there. */
export const HOOKS = ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh'] as const
/** Where the hooks live, relative to the home folder. */
export const HOOKS_DIR = '.claude/hooks/aspira'
/** The lines the global git ignore needs, so a project's working folders never show up in git status. */
export const IGNORE_ENTRIES = ['.work/', '.aspira/', '.worktrees/'] as const

export type HarnessOptions = {
  /** The home folder to write under; defaults to the user's. */
  home?: string
  /** The environment git's config and XDG_CONFIG_HOME are read from; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Progress lines; defaults to none. */
  log?: Log
  /** Warnings (a settings.json the kit will not touch); defaults to stderr. */
  warn?: Log
}

/** The kit's hook groups, as the template ships them (each command is `sh ~/.claude/hooks/aspira/<name>.sh`). */
type HookGroup = { matcher?: string; hooks: Array<{ type?: string; command?: string }> }
const settingsTemplate = (): Record<string, HookGroup[]> => readJson<{ hooks: Record<string, HookGroup[]> }>(join(KIT_DIR, 'templates', 'agent', 'claude-settings.json'))?.hooks ?? {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const lstatOf = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

const shown = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** The source folder of a skill in this kit package: skills/aspira-<name> for the kit's own, <agent>/skill/aspira-<agent> for an agent's. */
const skillSource = (name: SkillName): string => ((KIT_SKILLS as readonly string[]).includes(name) ? kitSkillDir(name as KitSkill) : join(KIT_DIR, name, 'skill', `aspira-${name}`))

/** The global git ignore file: core.excludesFile (a leading ~/ against home), else $XDG_CONFIG_HOME/git/ignore, else ~/.config/git/ignore. */
export function globalIgnoreFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  let configured = ''
  try {
    configured = execFileSync('git', ['config', '--global', '--get', 'core.excludesFile'], { env: { ...env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    // no git, or the key is not set
  }
  if (configured === '~') return home
  if (configured.startsWith('~/')) return join(home, configured.slice(2))
  if (configured !== '') return isAbsolute(configured) ? configured : resolve(home, configured)
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'git', 'ignore')
}

const ignoreHas = (text: string, entry: string): boolean => text.split('\n').some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ''))

/** Whether settings (parsed) already runs every command of the kit's template groups, under a group with the same matcher. */
function settingsRunHooks(settings: unknown): boolean {
  const hooks = isRecord(settings) ? settings.hooks : undefined
  if (!isRecord(hooks)) return false
  return Object.entries(settingsTemplate()).every(([event, groups]) => {
    const have = hooks[event]
    if (!Array.isArray(have)) return false
    return groups.every((group) =>
      group.hooks.every((hook) => have.some((g: unknown) => isRecord(g) && g.matcher === group.matcher && Array.isArray(g.hooks) && g.hooks.some((h: unknown) => isRecord(h) && h.command === hook.command))),
    )
  })
}

export type HarnessItem = { label: string; ok: boolean; reason?: string }

/** Every item of the global harness, each ok or with the reason it is not: the skills, the hooks, settings.json, the global ignore and any retired skill folder still there. */
export function harnessItems(opts: HarnessOptions = {}): HarnessItem[] {
  const home = homeOf(opts.home)
  const version = ownKitVersion()
  const items: HarnessItem[] = []
  const add = (label: string, reason?: string): void => {
    items.push(reason === undefined ? { label, ok: true } : { label, ok: false, reason })
  }
  for (const name of [...AGENTS, ...KIT_SKILLS]) {
    const dir = skillDir(home, name)
    const label = shown(dir, home)
    const stat = lstatOf(dir)
    if (stat === undefined) {
      add(label, `${label} is missing`)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      add(label, `${label} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a folder'}, not a copy of the kit's skill`)
      continue
    }
    const absent = ['SKILL.md', join('scripts', `${name}.sh`), VERSION_FILE].find((file) => !existsSync(join(dir, file)))
    if (absent !== undefined) {
      add(label, `${label}/${absent} is missing`)
      continue
    }
    const recorded = readFileSync(join(dir, VERSION_FILE), 'utf8').trim()
    add(label, version !== undefined && recorded === version ? undefined : `${label} is from ${recorded === '' ? '(no version)' : recorded}, the kit is ${version ?? '(unknown)'}`)
  }
  for (const name of HOOKS) {
    const file = join(home, HOOKS_DIR, name)
    const label = shown(file, home)
    add(label, lstatOf(file)?.isFile() === true ? undefined : `${label} is missing`)
  }
  const settingsPath = join(home, '.claude', 'settings.json')
  const settingsLabel = shown(settingsPath, home)
  if (!existsSync(settingsPath)) {
    add(settingsLabel, `${settingsLabel} is missing`)
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      parsed = undefined
    }
    add(settingsLabel, settingsRunHooks(parsed) ? undefined : `${settingsLabel} does not run the kit hooks (session-start.sh, deny-tier3.sh, audit-log.sh)`)
  }
  const ignorePath = globalIgnoreFile(home, opts.env)
  const ignoreLabel = shown(ignorePath, home)
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
  const lacking = IGNORE_ENTRIES.filter((entry) => !ignoreHas(ignoreText, entry))
  add(ignoreLabel, lacking.length === 0 ? undefined : `${ignoreLabel} lacks ${lacking.join(', ')}`)
  for (const retired of RETIRED_SKILLS) {
    const dir = skillDir(home, retired)
    if (lstatOf(dir) !== undefined) add(shown(dir, home), `${shown(dir, home)} is retired and should be removed`)
  }
  return items
}

/** The failing items of the global harness, as sentences; empty when the harness is current. One predicate for self-healing and `kit doctor`. */
export function harnessCurrent(opts: HarnessOptions = {}): string[] {
  return harnessItems(opts).flatMap((item) => (item.ok ? [] : [item.reason ?? item.label]))
}

const tempSuffix = (): string => `${String(process.pid)}-${randomBytes(3).toString('hex')}`

/** Put the finished folder `tmp` at `target`: the old one (a folder or a symlink) is renamed aside and removed, so no reader sees a partial folder. */
function swapIn(tmp: string, target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    const aside = `${target}.old-${tempSuffix()}`
    try {
      renameSync(target, aside)
      rmSync(aside, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
      renameSync(tmp, target)
      return
    } catch (err) {
      // Another kit process put its copy there first: take it aside again and retry.
      if (attempt >= 4 || !['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    }
  }
}

/** One skill folder: a copy of `source` stamped `version`, scripts executable, kept as is when already identical. */
function writeSkill(source: string, target: string, version: string, log: Log, label: string): void {
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`${AI_PACKAGE} ships no ${source}`)
  const wanted = tree(source)
  wanted.set(VERSION_FILE, Buffer.from(`${version}\n`))
  const stat = lstatOf(target)
  if (stat?.isDirectory() === true && !stat.isSymbolicLink() && sameTree(tree(target), wanted)) {
    log(`keep   ${label} (${version})`)
    return
  }
  log(`${stat === undefined ? 'write ' : 'update'} ${label} (${version})`)
  const tmp = `${target}.tmp-${tempSuffix()}`
  try {
    cpSync(source, tmp, { recursive: true })
    writeFileSync(join(tmp, VERSION_FILE), `${version}\n`)
    for (const [rel] of wanted) {
      if (rel.endsWith('.sh')) chmodSync(join(tmp, rel), 0o755)
    }
    swapIn(tmp, target)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** One hook file: a copy of the kit's, 0755, kept as is when identical. */
function writeHook(source: string, target: string, log: Log, label: string): void {
  if (!existsSync(source)) throw new Error(`${AI_PACKAGE} ships no ${source}`)
  const wanted = readFileSync(source)
  const stat = lstatOf(target)
  if (stat?.isFile() === true && (stat.mode & 0o777) === 0o755 && readFileSync(target).equals(wanted)) {
    log(`keep   ${label}`)
    return
  }
  log(`${stat === undefined ? 'write ' : 'update'} ${label}`)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${tempSuffix()}`
  try {
    copyFileSync(source, tmp)
    chmodSync(tmp, 0o755)
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** The settings with the kit's hook groups replaced by the template's; everything else is the engineer's. */
function mergeKitHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const base = dropKitHooks(existing)
  const hooks: Record<string, unknown> = isRecord(base.hooks) ? { ...base.hooks } : {}
  for (const [event, groups] of Object.entries(settingsTemplate())) {
    const have = hooks[event]
    hooks[event] = [...(Array.isArray(have) ? (have as unknown[]) : []), ...groups]
  }
  return { ...base, hooks }
}

function writeSettings(home: string, log: Log, warn: Log): void {
  const path = join(home, '.claude', 'settings.json')
  const label = shown(path, home)
  let existing: Record<string, unknown> = {}
  let mode = 0o600
  let target = path
  if (existsSync(path)) {
    target = realpathSync(path)
    mode = statSync(target).mode & 0o777
    const text = readFileSync(target, 'utf8')
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed)) {
      const entries = Object.entries(settingsTemplate()).map(([event, groups]) => `  ${event}${groups[0]?.matcher === undefined ? '' : ` (${groups[0].matcher})`}: ${groups.flatMap((group) => group.hooks.map((hook) => hook.command ?? '')).join(', ')}`)
      warn(`warning: ${path} has comments or is not valid JSON, so the kit left it unchanged. Add these hook entries by hand:\n${entries.join('\n')}`)
      return
    }
    existing = parsed
    if (settingsRunHooks(existing)) {
      log(`keep   ${label}`)
      return
    }
  }
  log(`${existsSync(path) ? 'update' : 'write '} ${label} (kit hooks)`)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${tempSuffix()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(mergeKitHooks(existing), null, 2)}\n`, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function writeIgnore(home: string, env: NodeJS.ProcessEnv | undefined, log: Log): void {
  const path = globalIgnoreFile(home, env)
  const label = shown(path, home)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const missing = IGNORE_ENTRIES.filter((entry) => !ignoreHas(text, entry))
  if (missing.length === 0) {
    log(`keep   ${label}`)
    return
  }
  log(`${existsSync(path) ? 'update' : 'write '} ${label} (${missing.join(', ')})`)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`)
}

/**
 * Write the global harness under <home>/.claude: the eleven skills (each a regular folder copied from this kit
 * and stamped with its version, swapped in whole so no reader sees a partial one; a symlinked aspira-<name>
 * is replaced, the engineer's other skills are untouched), the three hooks at 0755, the kit's hook groups
 * in settings.json (left alone with a warning when it is not strict JSON) and the three lines of the global
 * git ignore. Retired skill folders are removed. Every step runs; the failures are thrown together at the end.
 * Never reads or writes ~/.claude/CLAUDE.md.
 */
export function writeGlobalHarness(opts: HarnessOptions = {}): void {
  const home = homeOf(opts.home)
  const log = opts.log ?? (() => undefined)
  const warn = opts.warn ?? ((line: string) => void process.stderr.write(`${line}\n`))
  const version = ownKitVersion()
  const failures: string[] = []
  const step = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (version === undefined) throw new Error(`${AI_PACKAGE} has no version in ${join(KIT_DIR, 'package.json')}`)
  step(() => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    for (const name of [...AGENTS, ...KIT_SKILLS]) {
      const dir = skillDir(home, name)
      step(() => writeSkill(skillSource(name), dir, version, log, shown(dir, home)))
    }
    for (const retired of RETIRED_SKILLS) {
      const dir = skillDir(home, retired)
      if (lstatOf(dir) === undefined) continue
      log(`remove ${shown(dir, home)} (retired)`)
      step(() => rmSync(dir, { recursive: true, force: true }))
    }
  })
  step(() => {
    for (const name of HOOKS) {
      const file = join(home, HOOKS_DIR, name)
      step(() => writeHook(join(KIT_DIR, 'hooks', name), file, log, shown(file, home)))
    }
  })
  step(() => writeSettings(home, log, warn))
  step(() => writeIgnore(home, opts.env, log))
  if (failures.length > 0) throw new Error(failures.join('; '))
}
