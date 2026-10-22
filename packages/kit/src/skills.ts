// The installed /aspira-* skill packages: the seven agents and the build-feature orchestrating
// skill. Each package ships its skill under skill/aspira-<agent>/ (SKILL.md and scripts/<agent>.sh);
// `kit init` copies that folder into the project's .claude/skills/ and pins it to the installed
// @aspiralabs/agents version in .kit-version.
// The kit ships three skills of its own (/aspira-cleanup, /aspira-next, /aspira-worktree) under
// skills/aspira-<name>/, launchers for its own commands; they are copied the same way, pinned to the
// kit's version, and installed whether or not @aspiralabs/agents is.
// The copies are committed, so every clone has the same skills; `kit doctor` reports drift.
// The skills live at the project root (where Claude Code looks); the packages are installed under
// the app that owns package.json (`app` in aspira.json, the root itself for a single-app project).
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appRoot } from './aspira.js'
import { readJson, type Log } from './fs.js'

/** The agents a project gets through @aspiralabs/agents, each with a /aspira-<agent> skill. */
export const AGENTS = ['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'build-feature', 'visual-verify'] as const
/** Skills an earlier kit installed that no longer exist: `kit init` removes their folders (spec-reviewer folded into spec-writer, KIT-48). */
export const RETIRED_SKILLS = ['spec-reviewer'] as const
export type Agent = (typeof AGENTS)[number]

/** The skills @aspiralabs/kit ships itself, each a /aspira-<name> launcher for `kit <name>`. */
export const KIT_SKILLS = ['cleanup', 'next', 'worktree'] as const
export type KitSkill = (typeof KIT_SKILLS)[number]

/** Any /aspira-* skill kit installs: an agent's or one of the kit's own. */
export type SkillName = Agent | KitSkill

/** The package that brings every agent into a project. */
export const AGENTS_PACKAGE = '@aspiralabs/agents'
/** The package that ships the kit-owned skills. */
export const KIT_PACKAGE = '@aspiralabs/kit'
/** Where a skill records the kit version it was installed from. */
export const VERSION_FILE = '.kit-version'

/** This kit package's own directory (the parent of src/ or dist/), where skills/ ships. */
const KIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** The project's .claude/skills/aspira-<name>/ folder. */
export const skillDir = (projectRoot: string, name: SkillName): string => join(projectRoot, '.claude', 'skills', `aspira-${name}`)

/** The kit-owned skill's source folder in this kit package. */
export const kitSkillDir = (name: KitSkill): string => join(KIT_DIR, 'skills', `aspira-${name}`)

const isPackage = (dir: string, name: string): boolean => readJson<{ name?: string }>(join(dir, 'package.json'))?.name === name

/**
 * The installed @aspiralabs/<agent> package under `appDir` (the directory that owns node_modules), or undefined.
 * Lookup is by package.json name, not folder name. In order: a direct install in that node_modules; then,
 * from the real @aspiralabs/agents directory, its own node_modules/@aspiralabs/<agent> (where Node resolves
 * the meta-package's dependency, as in a workspace link) and the sibling folder whose package.json names
 * the package (pnpm's store, or this repository's packages/agents, where agent-common's folder is `common`).
 */
export function agentPackageDir(appDir: string, agent: Agent | 'agent-common'): string | undefined {
  const name = `@aspiralabs/${agent}`
  const scope = join(appDir, 'node_modules', '@aspiralabs')
  const direct = join(scope, agent)
  if (isPackage(direct, name)) {
    return direct
  }
  const meta = join(scope, 'agents')
  if (!existsSync(meta)) {
    return undefined
  }
  const realMeta = realpathSync(meta)
  const own = join(realMeta, 'node_modules', '@aspiralabs', agent)
  if (isPackage(own, name)) {
    return own
  }
  const parent = dirname(realMeta)
  // The folder named after the package first (the usual case), then any sibling that declares the name.
  const siblings = [agent, ...readdirSync(parent).filter((entry) => entry !== agent).sort()]
  return siblings.map((entry) => join(parent, entry)).find((dir) => isPackage(dir, name))
}

/** The installed version of @aspiralabs/agents under `appDir`, or undefined. */
export function agentsVersion(appDir: string): string | undefined {
  return readJson<{ version?: string }>(join(appDir, 'node_modules', '@aspiralabs', 'agents', 'package.json'))?.version
}

/** The installed version of @aspiralabs/kit under `appDir`, or undefined. */
export function kitVersion(appDir: string): string | undefined {
  return readJson<{ version?: string }>(join(appDir, 'node_modules', '@aspiralabs', 'kit', 'package.json'))?.version
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

export type InstallSkillsOptions = { projectRoot: string; app?: string; dryRun: boolean; log: Log }

/**
 * Copy one skill folder to `target` with .kit-version set to `version`, making its .sh files executable.
 * An up-to-date copy is kept; a dry run only logs.
 */
function copySkill(source: string, target: string, version: string, opts: InstallSkillsOptions): void {
  const shown = relative(opts.projectRoot, target)
  const wanted = tree(source)
  wanted.set(VERSION_FILE, Buffer.from(`${version}\n`))
  if (existsSync(target) && sameTree(tree(target), wanted)) {
    opts.log(`keep   ${shown} (${version})`)
    return
  }
  opts.log(`${existsSync(target) ? 'update' : 'write '} ${shown} (${version})`)
  if (opts.dryRun) {
    return
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
  writeFileSync(join(target, VERSION_FILE), `${version}\n`)
  for (const [rel] of wanted) {
    if (rel.endsWith('.sh')) chmodSync(join(target, rel), 0o755)
  }
}

/**
 * Write <projectRoot>/.claude/skills/aspira-<name>/ for every kit-owned skill (a copy of this kit
 * package's skills/aspira-<name>/, pinned to the kit's version) and for every agent: a copy of the
 * installed package's skill folder (from `<projectRoot>/<app>/node_modules`) plus .kit-version.
 * A re-run after a bump rewrites them; an up-to-date copy is kept.
 * Returns the agents whose skill could not be found (the package is not installed).
 */
export function installSkills(opts: InstallSkillsOptions): Agent[] {
  const app = appRoot(opts.projectRoot, opts.app)
  // The @aspiralabs/kit installed under the app, which kit doctor checks against; this package's own
  // version when none is installed there (kit run from elsewhere, before the install step).
  const kit = kitVersion(app) ?? ownKitVersion()
  for (const name of KIT_SKILLS) {
    const source = kitSkillDir(name)
    const target = skillDir(opts.projectRoot, name)
    if (kit === undefined || !existsSync(join(source, 'SKILL.md'))) {
      opts.log(`skip   ${relative(opts.projectRoot, target)} (${KIT_PACKAGE} ships no skills/aspira-${name} at ${KIT_DIR})`)
      continue
    }
    copySkill(source, target, kit, opts)
  }
  const version = agentsVersion(app)
  const missing: Agent[] = []
  if (version === undefined) {
    opts.log(`skip   .claude/skills/aspira-* (${AGENTS_PACKAGE} is not installed${opts.app ? ` in ${opts.app}` : ''}; run the install step, then kit init again)`)
    return [...AGENTS]
  }
  for (const retired of RETIRED_SKILLS) {
    const target = join(opts.projectRoot, '.claude', 'skills', `aspira-${retired}`)
    if (!existsSync(target)) continue
    opts.log(`remove ${relative(opts.projectRoot, target)} (retired)`)
    if (!opts.dryRun) rmSync(target, { recursive: true, force: true })
  }
  for (const agent of AGENTS) {
    const pkg = agentPackageDir(app, agent)
    const source = pkg === undefined ? undefined : join(pkg, 'skill', `aspira-${agent}`)
    const target = skillDir(opts.projectRoot, agent)
    if (source === undefined || !existsSync(join(source, 'SKILL.md'))) {
      opts.log(`skip   ${relative(opts.projectRoot, target)} (@aspiralabs/${agent} is not installed)`)
      missing.push(agent)
      continue
    }
    copySkill(source, target, version, opts)
  }
  return missing
}

export type SkillCheck = { name: SkillName; package: typeof AGENTS_PACKAGE | typeof KIT_PACKAGE; ok: boolean; reason?: string }

/** One skill folder: present, complete (SKILL.md and scripts/<name>.sh), and from `version` of `pkg`. */
function checkSkill(projectRoot: string, name: SkillName, pkg: SkillCheck['package'], version: string | undefined): SkillCheck {
  const dir = skillDir(projectRoot, name)
  const shown = relative(projectRoot, dir)
  const fail = (reason: string): SkillCheck => ({ name, package: pkg, ok: false, reason })
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(`${shown} is missing`)
  for (const file of ['SKILL.md', join('scripts', `${name}.sh`)]) {
    if (!existsSync(join(dir, file))) return fail(`${shown}/${file} is missing`)
  }
  const recorded = existsSync(join(dir, VERSION_FILE)) ? readFileSync(join(dir, VERSION_FILE), 'utf8').trim() : ''
  if (recorded === '') return fail(`${shown}/${VERSION_FILE} is missing`)
  if (version === undefined) return fail(`${pkg} is not installed, so ${shown} (${recorded}) cannot be checked`)
  if (recorded !== version) return fail(`${shown} is from ${recorded}, ${pkg} is ${version}`)
  return { name, package: pkg, ok: true }
}

/**
 * Each skill folder at the project root against the version installed under the app: the agent
 * skills against @aspiralabs/agents, then the kit-owned skills against @aspiralabs/kit.
 */
export function checkSkills(projectRoot: string, app?: string): SkillCheck[] {
  const appDir = appRoot(projectRoot, app)
  const agents = agentsVersion(appDir)
  const kit = kitVersion(appDir)
  return [
    ...AGENTS.map((agent) => checkSkill(projectRoot, agent, AGENTS_PACKAGE, agents)),
    ...KIT_SKILLS.map((name) => checkSkill(projectRoot, name, KIT_PACKAGE, kit)),
  ]
}
