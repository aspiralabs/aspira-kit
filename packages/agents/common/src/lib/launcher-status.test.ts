// T66 (plan.json P12, F5, A3): every launcher's separate-process `status` and `wait` subcommands,
// once P20 lands, read the run record at the agent's own record location (spec.reviewed/spec.reviewed.md,
// "Run record per skill") and exit by it: `RUNNING_EXIT` (75) while the run has not finished yet, and
// `exitCodeFor(status)` (run-status.ts, T2) once it has, printing `Run status: <status>` (reportHead,
// T4) before anything else, and the reason on anything but ready. Today none of the seven launchers'
// `cmd_status`/`cmd_wait` read the record or derive an exit code at all: a still-running call and a
// finished call both fall through to the script's last command and exit 0, whatever the trace says
// (packages/agents/spec-writer/skill/aspira-spec-writer/scripts/spec-writer.sh:256-271 cmd_status
// returns 0 while running and prints eve's exit; packages/agents/planner/skill/aspira-planner/scripts/planner.sh:254-276
// the same in the planner launcher). This file fails until P20 lands.
//
// Every status word, exit code and record path is copied from the spec's "Run record per skill"
// paragraph and F5/A3 (never recomputed the way the launcher would compute it, TEST-006).
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')
const RUNNING_EXIT = 75

type Launcher = {
  /** The agent name: matches scripts/<name>.sh and the SKILL.md folder aspira-<name>. */
  name: string
  /** The env var the launcher's resolve_agent reads for a kit-development override. */
  envVar: string
  /** The skill folder, relative to the repo root, that ships scripts/<name>.sh. */
  skillDir: string
  /** The real source package directory for envVar, relative to the repo root. */
  agentDir: string
  /** The run record's path, relative to the run's `output` folder ("Run record per skill", spec.reviewed.md). */
  recordPath: string
}

// The seven agent launchers T66 covers (build-feature is not one of them: it has no start/status/wait).
const LAUNCHERS: Launcher[] = [
  { name: 'groomer', envVar: 'GROOMER_AGENT_DIR', skillDir: 'packages/agents/groomer/skill/aspira-groomer', agentDir: 'packages/agents/groomer', recordPath: 'trace/groom.json' },
  { name: 'spec-writer', envVar: 'SPEC_WRITER_AGENT_DIR', skillDir: 'packages/agents/spec-writer/skill/aspira-spec-writer', agentDir: 'packages/agents/spec-writer', recordPath: 'trace/review.json' },
  { name: 'spec-reviewer', envVar: 'SPEC_REVIEWER_AGENT_DIR', skillDir: 'packages/agents/spec-reviewer/skill/aspira-spec-reviewer', agentDir: 'packages/agents/spec-reviewer', recordPath: 'trace/review.json' },
  { name: 'planner', envVar: 'PLANNER_AGENT_DIR', skillDir: 'packages/agents/planner/skill/aspira-planner', agentDir: 'packages/agents/planner', recordPath: 'trace/review.json' },
  { name: 'implementor', envVar: 'IMPLEMENTOR_AGENT_DIR', skillDir: 'packages/agents/implementor/skill/aspira-implementor', agentDir: 'packages/agents/implementor', recordPath: 'trace/implementation-local.json' },
  { name: 'code-analyzer', envVar: 'CODE_ANALYZER_AGENT_DIR', skillDir: 'packages/agents/code-analyzer/skill/aspira-code-analyzer', agentDir: 'packages/agents/code-analyzer', recordPath: 'rounds.json' },
  { name: 'pr-reviewer', envVar: 'PR_REVIEWER_AGENT_DIR', skillDir: 'packages/agents/pr-reviewer/skill/aspira-pr-reviewer', agentDir: 'packages/agents/pr-reviewer', recordPath: 'trace/review.json' },
]

/** A run directory with `started` (five seconds ago) and an `output` file naming a folder this test
 * also creates, so a run record can be written at the launcher's own recordPath inside it. */
async function makeRun(): Promise<{ run: string; output: string }> {
  const run = await mkdtemp(join(tmpdir(), 'launcher-status-run-'))
  const output = await mkdtemp(join(tmpdir(), 'launcher-status-output-'))
  await writeFile(join(run, 'started'), `${Math.floor(Date.now() / 1000) - 5}\n`)
  await writeFile(join(run, 'output'), `${output}\n`)
  return { run, output }
}

async function writeRecord(output: string, recordPath: string, record: unknown): Promise<void> {
  const file = join(output, recordPath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(record))
}

function runSub(scriptPath: string, sub: string, args: string[], envVar: string, agentDir: string): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, [envVar]: agentDir }
  delete env.NOTION_TOKEN
  delete env.NOTION_API_KEY
  delete env.AI_GATEWAY_API_KEY
  const result = spawnSync('bash', [scriptPath, sub, ...args], { env, encoding: 'utf8', timeout: 15_000 })
  return { stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status }
}

describe.each(LAUNCHERS)('$name status/wait read the run record and exit by it (T66, F5)', (launcher) => {
  const scriptPath = join(ROOT, launcher.skillDir, 'scripts', `${launcher.name}.sh`)
  const agentDir = join(ROOT, launcher.agentDir)
  let run: string
  let output: string

  afterEach(async () => {
    await rm(run, { recursive: true, force: true })
    await rm(output, { recursive: true, force: true })
  })

  it('with no exit file, status and wait both print running and exit 75', async () => {
    ;({ run, output } = await makeRun())
    const status = runSub(scriptPath, 'status', [run], launcher.envVar, agentDir)
    expect(status.stdout).toContain('running')
    expect(status.status).toBe(RUNNING_EXIT)

    const wait = runSub(scriptPath, 'wait', [run, '--max', '1'], launcher.envVar, agentDir)
    expect(wait.stdout).toContain('running')
    expect(wait.status).toBe(RUNNING_EXIT)
  })

  it('a needs-author record prints the status and its reason first, and exits 1 although eve exited 0', async () => {
    ;({ run, output } = await makeRun())
    await writeFile(join(run, 'exit'), '0\n')
    await writeRecord(output, launcher.recordPath, { status: 'needs-author', reason: 'open decisions remain', reasonCode: null })

    const result = runSub(scriptPath, 'status', [run], launcher.envVar, agentDir)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe('Run status: needs-author')
    expect(lines[1]).toContain('open decisions remain')
    expect(result.status).toBe(1)
  })

  it('a ready record exits 0; a missing record exits 1 with status incomplete', async () => {
    ;({ run, output } = await makeRun())
    await writeFile(join(run, 'exit'), '0\n')
    await writeRecord(output, launcher.recordPath, { status: 'ready', reason: null, reasonCode: null })
    const ready = runSub(scriptPath, 'status', [run], launcher.envVar, agentDir)
    expect(ready.status).toBe(0)

    await rm(join(output, launcher.recordPath), { force: true })
    const missing = runSub(scriptPath, 'status', [run], launcher.envVar, agentDir)
    expect(missing.stdout).toContain('Run status: incomplete')
    expect(missing.status).toBe(1)
  })
})
