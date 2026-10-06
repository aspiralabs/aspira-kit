// The /aspira-* skills a project runs its agents with. Each agent package ships its skill under
// skill/aspira-<agent>/ (SKILL.md and scripts/<agent>.sh); `kit init` copies that folder into the
// project's .claude/skills/ and pins it to the installed @aspiralabs/agents version in .kit-version.
// The copies are committed, so every clone has the same skills; `kit doctor` reports drift.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readJson, type Log } from './fs.js'

/** The agents a project gets through @aspiralabs/agents, each with a /aspira-<agent> skill. */
export const AGENTS = ['spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const
export type Agent = (typeof AGENTS)[number]

/** The package that brings every agent into a project. */
export const AGENTS_PACKAGE = '@aspiralabs/agents'
/** Where a skill records the kit version it was installed from. */
export const VERSION_FILE = '.kit-version'

/** The project's .claude/skills/aspira-<agent>/ folder. */
export const skillDir = (projectRoot: string, agent: Agent): string => join(projectRoot, '.claude', 'skills', `aspira-${agent}`)

const isPackage = (dir: string, name: string): boolean => readJson<{ name?: string }>(join(dir, 'package.json'))?.name === name

/** The installed @aspiralabs/<agent> package, or undefined. Direct installs sit in the project's node_modules; with pnpm the agents sit beside @aspiralabs/agents in its own folder instead. */
export function agentPackageDir(projectRoot: string, agent: Agent | 'agent-common'): string | undefined {
  const scope = join(projectRoot, 'node_modules', '@aspiralabs')
  const direct = join(scope, agent)
  if (isPackage(direct, `@aspiralabs/${agent}`)) {
    return direct
  }
  const meta = join(scope, 'agents')
  if (existsSync(meta)) {
    const sibling = join(realpathSync(meta), '..', agent)
    if (isPackage(sibling, `@aspiralabs/${agent}`)) {
      return sibling
    }
  }
  return undefined
}

/** The installed version of @aspiralabs/agents, or undefined. */
export function agentsVersion(projectRoot: string): string | undefined {
  return readJson<{ version?: string }>(join(projectRoot, 'node_modules', '@aspiralabs', 'agents', 'package.json'))?.version
}

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

export type InstallSkillsOptions = { projectRoot: string; dryRun: boolean; log: Log }

/**
 * Write .claude/skills/aspira-<agent>/ for every agent: a copy of the installed package's
 * skill folder plus .kit-version. A re-run after a bump rewrites them; an up-to-date copy is kept.
 * Returns the agents whose skill could not be found (the package is not installed).
 */
export function installSkills(opts: InstallSkillsOptions): Agent[] {
  const version = agentsVersion(opts.projectRoot)
  const missing: Agent[] = []
  if (version === undefined) {
    opts.log(`skip   .claude/skills/aspira-* (${AGENTS_PACKAGE} is not installed; run the install step, then kit init again)`)
    return [...AGENTS]
  }
  for (const agent of AGENTS) {
    const pkg = agentPackageDir(opts.projectRoot, agent)
    const source = pkg === undefined ? undefined : join(pkg, 'skill', `aspira-${agent}`)
    const target = skillDir(opts.projectRoot, agent)
    const shown = relative(opts.projectRoot, target)
    if (source === undefined || !existsSync(join(source, 'SKILL.md'))) {
      opts.log(`skip   ${shown} (@aspiralabs/${agent} is not installed)`)
      missing.push(agent)
      continue
    }
    const wanted = tree(source)
    wanted.set(VERSION_FILE, Buffer.from(`${version}\n`))
    if (existsSync(target) && sameTree(tree(target), wanted)) {
      opts.log(`keep   ${shown} (${version})`)
      continue
    }
    opts.log(`${existsSync(target) ? 'update' : 'write '} ${shown} (${version})`)
    if (opts.dryRun) {
      continue
    }
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true })
    writeFileSync(join(target, VERSION_FILE), `${version}\n`)
    for (const [rel] of wanted) {
      if (rel.endsWith('.sh')) chmodSync(join(target, rel), 0o755)
    }
  }
  return missing
}

export type SkillCheck = { agent: Agent; ok: boolean; reason?: string }

/** Each skill folder against the installed @aspiralabs/agents version: present, complete, and from that version. */
export function checkSkills(projectRoot: string): SkillCheck[] {
  const version = agentsVersion(projectRoot)
  return AGENTS.map((agent) => {
    const dir = skillDir(projectRoot, agent)
    const shown = relative(projectRoot, dir)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { agent, ok: false, reason: `${shown} is missing` }
    for (const file of ['SKILL.md', join('scripts', `${agent}.sh`)]) {
      if (!existsSync(join(dir, file))) return { agent, ok: false, reason: `${shown}/${file} is missing` }
    }
    const recorded = existsSync(join(dir, VERSION_FILE)) ? readFileSync(join(dir, VERSION_FILE), 'utf8').trim() : ''
    if (!recorded) return { agent, ok: false, reason: `${shown}/${VERSION_FILE} is missing` }
    if (version === undefined) return { agent, ok: false, reason: `${AGENTS_PACKAGE} is not installed, so ${shown} (${recorded}) cannot be checked` }
    if (recorded !== version) return { agent, ok: false, reason: `${shown} is from ${recorded}, ${AGENTS_PACKAGE} is ${version}` }
    return { agent, ok: true }
  })
}
