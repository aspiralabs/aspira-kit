// T67 (plan.json P12, F8, A3): every launcher checks the skill's `.kit-version` against the
// installed `@aspiralabs/agents` before it starts (packages/kit/src/skills.ts:122-137 checkSkills
// compares .kit-version with the installed version; packages/agents/planner/skill/aspira-planner/scripts/planner.sh:52-90
// resolve_agent, which has no such check yet). The implementation wave (plan.json P20) makes
// resolve_agent, when the agent source is the installed package, compare the skill's own
// `.kit-version` with `node_modules/@aspiralabs/agents`'s version: a mismatch ends the run blocked,
// printing `kit init`, before anything is launched (F8). Running from source (the kit-development
// env override, or the package checkout) only warns and continues (R14). This file fails until
// that lands: today resolve_agent never reads `.kit-version`, so an installed mismatch still runs.
//
// Every expected value here is copied from the spec (spec.reviewed/spec.reviewed.md F8) and the
// plan's own P20 task description, never recomputed the way resolve_agent would compute it (TEST-006).
import { execFileSync, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')

type Launcher = {
  /** The agent name: matches scripts/<name>.sh, the SKILL.md folder aspira-<name> and @aspiralabs/<name>. */
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
  { name: 'groomer', envVar: 'GROOMER_AGENT_DIR', skillDir: 'packages/agents/groomer/skill/aspira-groomer', args: ['local', 'KIT-2'] },
  { name: 'spec-writer', envVar: 'SPEC_WRITER_AGENT_DIR', skillDir: 'packages/agents/spec-writer/skill/aspira-spec-writer', args: ['local', 'KIT-2'] },
  { name: 'spec-reviewer', envVar: 'SPEC_REVIEWER_AGENT_DIR', skillDir: 'packages/agents/spec-reviewer/skill/aspira-spec-reviewer', args: ['local', 'KIT-2'] },
  { name: 'planner', envVar: 'PLANNER_AGENT_DIR', skillDir: 'packages/agents/planner/skill/aspira-planner', args: ['local', 'KIT-2'] },
  { name: 'implementor', envVar: 'IMPLEMENTOR_AGENT_DIR', skillDir: 'packages/agents/implementor/skill/aspira-implementor', args: ['local', 'KIT-2'] },
  { name: 'code-analyzer', envVar: 'CODE_ANALYZER_AGENT_DIR', skillDir: 'packages/agents/code-analyzer/skill/aspira-code-analyzer', args: ['local', 'KIT-2'] },
  { name: 'pr-reviewer', envVar: 'PR_REVIEWER_AGENT_DIR', skillDir: 'packages/agents/pr-reviewer/skill/aspira-pr-reviewer', args: ['local', 'KIT-2'] },
  { name: 'build-feature', envVar: 'BUILD_FEATURE_AGENT_DIR', skillDir: 'packages/agents/build-feature/skill/aspira-build-feature', args: ['local', 'KIT-2'] },
]

const AGENTS_VERSION = '0.8.0'
const SKILL_KIT_VERSION = '0.7.0'

// A stub `scripts/local.ts`: every launcher's `local` subcommand ends by `exec`-ing node on this
// file from inside the agent package directory (agent_node / cmd_local, every <agent>.sh). It
// never touches Notion or GitHub (TEST-003, TEST-007): it only records that it ran, so the test
// can tell a blocked run (F8) from one that reached the agent.
const STUB_LOCAL_TS = "require('node:fs').writeFileSync('ran.marker', JSON.stringify(process.argv.slice(2)))\n"

/** A fresh git repository (resolve_agent's project_root and every launcher's `parse` need one) with
 * node_modules/@aspiralabs/agents at AGENTS_VERSION, a stub node_modules/@aspiralabs/<agent> package
 * (whose scripts/local.ts records a run), amaro (so a non-blocked run can reach node) and the
 * launcher's skill folder copied in with .kit-version at SKILL_KIT_VERSION (F8's mismatch). */
async function makeProject(launcher: Launcher): Promise<{ project: string; scriptPath: string; stubDir: string }> {
  const project = await mkdtemp(join(tmpdir(), 'launcher-version-'))
  execFileSync('git', ['init', '-q'], { cwd: project })

  const agentsDir = join(project, 'node_modules', '@aspiralabs', 'agents')
  await mkdir(agentsDir, { recursive: true })
  await writeFile(join(agentsDir, 'package.json'), JSON.stringify({ name: '@aspiralabs/agents', version: AGENTS_VERSION }, null, 2))

  const stubDir = join(project, 'node_modules', '@aspiralabs', launcher.name)
  await mkdir(join(stubDir, 'scripts'), { recursive: true })
  await writeFile(join(stubDir, 'package.json'), JSON.stringify({ name: `@aspiralabs/${launcher.name}`, version: SKILL_KIT_VERSION }, null, 2))
  await writeFile(join(stubDir, 'scripts', 'local.ts'), STUB_LOCAL_TS)

  const amaroDir = join(project, 'node_modules', 'amaro', 'dist')
  await mkdir(amaroDir, { recursive: true })
  await writeFile(join(amaroDir, 'register-strip.mjs'), 'export {}\n')

  const skillTarget = join(project, '.claude', 'skills', `aspira-${launcher.name}`)
  await cp(join(ROOT, launcher.skillDir), skillTarget, { recursive: true })
  await writeFile(join(skillTarget, '.kit-version'), `${SKILL_KIT_VERSION}\n`)
  const scriptPath = join(skillTarget, 'scripts', `${launcher.name}.sh`)
  await chmod(scriptPath, 0o755)

  return { project, scriptPath, stubDir }
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

describe.each(LAUNCHERS)('$name .kit-version vs. installed @aspiralabs/agents (T67, F8)', (launcher) => {
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
    expect(await ran(made.stubDir)).toBe(false)
  })

  it('the AGENT_DIR kit-development override only warns about the mismatch, and the agent runs', async () => {
    const made = await makeProject(launcher)
    project = made.project
    const result = runLocal(project, made.scriptPath, launcher.args, launcher.envVar, made.stubDir)
    expect(result.stdout.toLowerCase()).toMatch(/mismatch/)
    expect(await ran(made.stubDir)).toBe(true)
  })
})
