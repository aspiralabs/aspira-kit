// T67 (plan.json P12, F8, A3): every launcher checks the skill's `.kit-version` against the
// installed `@aspiralabs/agents` before it starts (packages/ai/src/skills.ts checkSkills
// compares .kit-version with the installed version; packages/ai/planner/skill/aspira-planner/scripts/planner.sh:52-90
// resolve_agent, which has no such check yet). The implementation wave (plan.json P20) makes
// resolve_agent, when the agent source is the installed package, compare the skill's own
// `.kit-version` with `node_modules/@aspiralabs/ai`'s version: a mismatch ends the run blocked,
// printing `kit init`, before anything is launched (F8). Running from source (the kit-development
// env override, or the package checkout) only warns and continues (R14). This file fails until
// that lands: today resolve_agent never reads `.kit-version`, so an installed mismatch still runs.
//
// Every expected value here is copied from the spec (spec.reviewed/spec.reviewed.md F8) and the
// plan's own P20 task description, never recomputed the way resolve_agent would compute it (TEST-006).
import { execFileSync, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')

type Launcher = {
  /** The agent name: matches scripts/<name>.sh, the SKILL.md folder aspira-<name> and the folder <name> inside @aspiralabs/ai. */
  name: string
  /** The env var a launcher's resolve_agent reads for a kit-development override. */
  envVar: string
  /** The skill folder, relative to the repo root, that ships scripts/<name>.sh and SKILL.md. */
  skillDir: string
  /** The `local` subcommand's own arguments (every launcher's `local` ends in `scripts/local.ts`). */
  args: string[]
}

// The eight launchers kit installs (packages/kit/src/skills.ts AGENTS), each with its own `local`.
const LAUNCHERS: Launcher[] = [
  { name: 'groomer', envVar: 'GROOMER_AGENT_DIR', skillDir: 'packages/ai/groomer/skill/aspira-groomer', args: ['local', 'KIT-2'] },
  { name: 'spec-writer', envVar: 'SPEC_WRITER_AGENT_DIR', skillDir: 'packages/ai/spec-writer/skill/aspira-spec-writer', args: ['local', 'KIT-2'] },
  { name: 'planner', envVar: 'PLANNER_AGENT_DIR', skillDir: 'packages/ai/planner/skill/aspira-planner', args: ['local', 'KIT-2'] },
  { name: 'implementor', envVar: 'IMPLEMENTOR_AGENT_DIR', skillDir: 'packages/ai/implementor/skill/aspira-implementor', args: ['local', 'KIT-2'] },
  { name: 'code-analyzer', envVar: 'CODE_ANALYZER_AGENT_DIR', skillDir: 'packages/ai/code-analyzer/skill/aspira-code-analyzer', args: ['local', 'KIT-2'] },
  { name: 'pr-reviewer', envVar: 'PR_REVIEWER_AGENT_DIR', skillDir: 'packages/ai/pr-reviewer/skill/aspira-pr-reviewer', args: ['local', 'KIT-2'] },
  { name: 'build-feature', envVar: 'BUILD_FEATURE_AGENT_DIR', skillDir: 'packages/ai/build-feature/skill/aspira-build-feature', args: ['local', 'KIT-2'] },
  { name: 'visual-verify', envVar: 'VISUAL_VERIFY_AGENT_DIR', skillDir: 'packages/ai/visual-verify/skill/aspira-visual-verify', args: ['local', 'KIT-2'] },
]

const AI_VERSION = '0.8.0'
const SKILL_KIT_VERSION = '0.7.0'

// A stub `scripts/local.ts`: every launcher's `local` subcommand ends by `exec`-ing node on this
// file from inside the agent package directory (agent_node / cmd_local, every <agent>.sh). It
// never touches Notion or GitHub (TEST-003, TEST-007): it only records that it ran, so the test
// can tell a blocked run (F8) from one that reached the agent.
const STUB_LOCAL_TS = "require('node:fs').writeFileSync('ran.marker', JSON.stringify(process.argv.slice(2)))\n"

/** A fresh git repository (resolve_agent's project_root and every launcher's `parse` need one) with
 * node_modules/@aspiralabs/ai at AI_VERSION, a stub node_modules/@aspiralabs/ai/<agent> folder
 * (whose scripts/local.ts records a run), amaro (so a non-blocked run can reach node) and the
 * launcher's skill folder copied in with .kit-version at SKILL_KIT_VERSION (F8's mismatch). */
async function makeProject(launcher: Launcher): Promise<{ project: string; scriptPath: string; stubDir: string; sourceDir: string }> {
  const project = await mkdtemp(join(tmpdir(), 'launcher-version-'))
  execFileSync('git', ['init', '-q'], { cwd: project })

  const aiDir = join(project, 'node_modules', '@aspiralabs', 'ai')
  await mkdir(aiDir, { recursive: true })
  await writeFile(join(aiDir, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: AI_VERSION }, null, 2))

  const stubDir = join(aiDir, launcher.name)
  await mkdir(join(stubDir, 'scripts'), { recursive: true })
  await mkdir(join(stubDir, 'skill'), { recursive: true })
  await writeFile(join(stubDir, 'scripts', 'local.ts'), STUB_LOCAL_TS)

  // The kit-development override points at a kit source checkout, never at node_modules: Node's
  // built-in type stripping refuses any .ts under node_modules, and only the real amaro hook (a
  // no-op stub here) lifts that, so an override aimed at the installed stub could never run it.
  const sourceDir = join(project, 'aspira-kit', 'packages', 'ai', launcher.name)
  await mkdir(join(sourceDir, 'scripts'), { recursive: true })
  await mkdir(join(sourceDir, 'skill'), { recursive: true })
  await writeFile(join(project, 'aspira-kit', 'packages', 'ai', 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: SKILL_KIT_VERSION }, null, 2))
  await writeFile(join(sourceDir, 'scripts', 'local.ts'), STUB_LOCAL_TS)

  const amaroDir = join(project, 'node_modules', 'amaro', 'dist')
  await mkdir(amaroDir, { recursive: true })
  await writeFile(join(amaroDir, 'register-strip.mjs'), 'export {}\n')

  const skillTarget = join(project, '.claude', 'skills', `aspira-${launcher.name}`)
  await cp(join(ROOT, launcher.skillDir), skillTarget, { recursive: true })
  await writeFile(join(skillTarget, '.kit-version'), `${SKILL_KIT_VERSION}\n`)
  const scriptPath = join(skillTarget, 'scripts', `${launcher.name}.sh`)
  await chmod(scriptPath, 0o755)

  return { project, scriptPath, stubDir, sourceDir }
}

function runLocal(project: string, scriptPath: string, args: string[], envVar: string, agentDir?: string): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NOTION_TOKEN
  delete env.NOTION_API_KEY
  delete env.AI_GATEWAY_API_KEY
  if (agentDir !== undefined) env[envVar] = agentDir
  else delete env[envVar]
  const result = spawnSync('bash', [scriptPath, ...args], { cwd: project, env, encoding: 'utf8', timeout: 15_000 })
  return { stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status }
}

async function ran(stubDir: string): Promise<boolean> {
  try {
    await access(join(stubDir, 'ran.marker'))
    return true
  } catch {
    return false
  }
}

describe.each(LAUNCHERS)('$name .kit-version vs. installed @aspiralabs/ai (T67, T16, F5, F8)', (launcher) => {
  let project: string

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('an installed mismatch blocks the run, prints kit init, and the agent never runs', async () => {
    const made = await makeProject(launcher)
    project = made.project
    const result = runLocal(project, made.scriptPath, launcher.args, launcher.envVar)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('kit init')
    expect(result.stdout).toContain(`@aspiralabs/ai ${SKILL_KIT_VERSION}`)
    expect(result.stdout).toContain(AI_VERSION)
    expect(result.stdout).not.toContain('@aspiralabs/agents')
    expect(await ran(made.stubDir)).toBe(false)
  })

  it('matching versions run the agent', async () => {
    const made = await makeProject(launcher)
    project = made.project
    await writeFile(join(project, '.claude', 'skills', `aspira-${launcher.name}`, '.kit-version'), `${AI_VERSION}\n`)
    // Node refuses to strip types from a .ts under node_modules unless the real amaro hook is loaded
    // (the stub amaro here is a no-op), so the installed folder is a symlink to the kit source: the
    // launcher resolves it to its real path (pwd -P), still takes it as the installed agent, and runs it.
    await rm(made.stubDir, { recursive: true, force: true })
    await symlink(made.sourceDir, made.stubDir)
    const result = runLocal(project, made.scriptPath, launcher.args, launcher.envVar)
    expect(await ran(made.sourceDir)).toBe(true)
    expect(result.stdout).not.toContain('@aspiralabs/agents')
  })

  it('the AGENT_DIR kit-development override only warns about the mismatch, and the agent runs', async () => {
    const made = await makeProject(launcher)
    project = made.project
    const result = runLocal(project, made.scriptPath, launcher.args, launcher.envVar, made.sourceDir)
    expect(result.stdout.toLowerCase()).toMatch(/mismatch/)
    expect(result.stdout).not.toContain('@aspiralabs/agents')
    expect(await ran(made.sourceDir)).toBe(true)
    expect(await ran(made.stubDir)).toBe(false)
  })
})
