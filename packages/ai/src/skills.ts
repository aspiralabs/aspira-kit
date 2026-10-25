// The installed /aspira-* skills: eight agent skills and three kit launchers, all from one package,
// @aspiralabs/ai. Each agent ships its skill under <agent>/skill/aspira-<agent>/ and the kit skills
// sit under skills/aspira-<name>/ (SKILL.md and scripts/<name>.sh); `kit init` copies them into the
// project's .claude/skills/ and pins each to the @aspiralabs/ai version in .kit-version.
// @aspiralabs/ai is installed globally (pnpm add -g), so the source is the running kit's own package;
// a project that still has it under its app's node_modules (an earlier kit) uses that copy instead.
// The copies are committed, so every clone has the same skills; `kit doctor` reports drift.
// The hooks are copied the same way, into .claude/hooks/aspira/, so nothing points into node_modules.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appRoot } from './aspira.js'
import { readJson, type Log } from './fs.js'

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

/** The project's .claude/skills/aspira-<name>/ folder. */
export const skillDir = (projectRoot: string, name: SkillName): string => join(projectRoot, '.claude', 'skills', `aspira-${name}`)

/** The kit-owned skill's source folder in this kit package. */
export const kitSkillDir = (name: KitSkill): string => join(KIT_DIR, 'skills', `aspira-${name}`)

const isPackage = (dir: string, name: string): boolean => readJson<{ name?: string }>(join(dir, 'package.json'))?.name === name

/** This kit package's directory: the global @aspiralabs/ai `kit` runs from (or the source checkout). `kit package-dir` prints it for the launchers. */
export const kitPackageDir = (): string => KIT_DIR

/**
 * The @aspiralabs/ai a project uses: one still installed under `appDir` (the directory that owns node_modules,
 * from a kit before global installs), else the running kit's own package, the global install.
 */
export function aiPackageDir(appDir: string): string | undefined {
  const dir = join(appDir, 'node_modules', '@aspiralabs', 'ai')
  if (isPackage(dir, AI_PACKAGE)) return dir
  return isPackage(KIT_DIR, AI_PACKAGE) ? KIT_DIR : undefined
}

/** The version of the @aspiralabs/ai the project uses (see aiPackageDir), or undefined. */
export function aiVersion(appDir: string): string | undefined {
  const dir = aiPackageDir(appDir)
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
 * Write <projectRoot>/.claude/skills/aspira-<name>/ for all eleven skills, each a copy of the @aspiralabs/ai
 * folder (aiPackageDir: the global install, or a copy still under the app) stamped with its version: kit
 * skills from skills/aspira-<name>, agent skills from <agent>/skill/aspira-<agent>. A re-run after a bump
 * rewrites them; an up-to-date copy is kept. Returns the agents whose skill could not be found.
 */
export function installSkills(opts: InstallSkillsOptions): Agent[] {
  const app = appRoot(opts.projectRoot, opts.app)
  const ai = aiPackageDir(app)
  const version = aiVersion(app)
  const kit = version ?? ownKitVersion()
  for (const name of KIT_SKILLS) {
    const source = ai === undefined ? kitSkillDir(name) : join(ai, 'skills', `aspira-${name}`)
    const target = skillDir(opts.projectRoot, name)
    if (kit === undefined || !existsSync(join(source, 'SKILL.md'))) {
      opts.log(`skip   ${relative(opts.projectRoot, target)} (${AI_PACKAGE} ships no skills/aspira-${name} at ${dirname(source)})`)
      continue
    }
    copySkill(source, target, kit, opts)
  }
  if (ai === undefined || version === undefined) {
    opts.log(`skip   .claude/skills/aspira-* (${AI_PACKAGE} is not installed${opts.app ? ` in ${opts.app}` : ''}; run the install step, then kit init again)`)
    return [...AGENTS]
  }
  for (const retired of RETIRED_SKILLS) {
    const target = join(opts.projectRoot, '.claude', 'skills', `aspira-${retired}`)
    if (!existsSync(target)) continue
    opts.log(`remove ${relative(opts.projectRoot, target)} (retired)`)
    if (!opts.dryRun) rmSync(target, { recursive: true, force: true })
  }
  const missing: Agent[] = []
  for (const agent of AGENTS) {
    const source = join(ai, agent, 'skill', `aspira-${agent}`)
    const target = skillDir(opts.projectRoot, agent)
    if (!existsSync(join(source, 'SKILL.md'))) {
      opts.log(`skip   ${relative(opts.projectRoot, target)} (${AI_PACKAGE} ships no ${agent}/skill/aspira-${agent})`)
      missing.push(agent)
      continue
    }
    copySkill(source, target, version, opts)
  }
  return missing
}

/** The hooks `kit init` copies from @aspiralabs/ai's hooks/ into the project; .claude/settings.json runs them from there. */
export const HOOKS = ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh'] as const
/** Where the copied hooks live, relative to the project root. */
export const HOOKS_DIR = '.claude/hooks/aspira'

/** Copy each hook into <projectRoot>/.claude/hooks/aspira/, executable. An up-to-date copy is kept; a dry run only logs. */
export function installHooks(opts: InstallSkillsOptions): void {
  const ai = aiPackageDir(appRoot(opts.projectRoot, opts.app))
  for (const name of HOOKS) {
    const target = join(opts.projectRoot, HOOKS_DIR, name)
    const shown = relative(opts.projectRoot, target)
    const source = ai === undefined ? undefined : join(ai, 'hooks', name)
    if (source === undefined || !existsSync(source)) {
      opts.log(`skip   ${shown} (${AI_PACKAGE} ships no hooks/${name})`)
      continue
    }
    const wanted = readFileSync(source)
    if (existsSync(target) && readFileSync(target).equals(wanted)) {
      opts.log(`keep   ${shown}`)
      continue
    }
    opts.log(`${existsSync(target) ? 'update' : 'write '} ${shown}`)
    if (opts.dryRun) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, wanted)
    chmodSync(target, 0o755)
  }
}

export type SkillCheck = { name: SkillName; package: typeof AI_PACKAGE; ok: boolean; reason?: string }

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

/** Each of the eleven skill folders at the project root against the @aspiralabs/ai version installed under the app. */
export function checkSkills(projectRoot: string, app?: string): SkillCheck[] {
  const version = aiVersion(appRoot(projectRoot, app))
  return [...AGENTS, ...KIT_SKILLS].map((name) => checkSkill(projectRoot, name, AI_PACKAGE, version))
}
