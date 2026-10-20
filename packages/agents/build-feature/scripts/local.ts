// The build-feature driver, as `build-feature.sh local` runs it:
//   local.ts <ID> [--local] [--repo <dir>] [--run <runId>] [--force-run] [--finish]
// With --local every step runs its skill with --local in this session; without it every step runs
// its skill's default mode (the step's cloud agent, started and waited on). F2, Q10 revised.
// Prints exactly one stage as JSON on stdout and exits 0, except the `end` stage, which exits by
// its run status (A2); a refusal prints its message on stderr and exits 1. Time comes from BUILD_FEATURE_NOW when set (tests), else the clock.

import { parseArgs } from 'node:util'
import { exitCodeFor, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'
import { buildRunStatus } from '#src/build-status.ts'
import { nextStage, Refusal } from '#src/driver.ts'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      local: { type: 'boolean', default: false },
      repo: { type: 'string' },
      run: { type: 'string' },
      'force-run': { type: 'boolean', default: false },
      finish: { type: 'boolean', default: false },
      autonomous: { type: 'boolean', default: false },
    },
  })
  const [id] = positionals
  if (id === undefined || !/^[A-Za-z]+-\d+$/.test(id)) throw new Refusal('Usage: local.ts <ID> [--local] [--autonomous] [--run <runId>] [--force-run] [--finish]; <ID> is the Feature Board ticket ID, for example KIT-11.')
  const now = process.env.BUILD_FEATURE_NOW !== undefined && process.env.BUILD_FEATURE_NOW !== '' ? process.env.BUILD_FEATURE_NOW : new Date().toISOString()
  const stage = await nextStage({
    id: id.toUpperCase(),
    repo: values.repo ?? process.cwd(),
    ...(values.run === undefined ? {} : { run: values.run }),
    forceRun: values['force-run'],
    finish: values.finish,
    mode: values.local ? 'local' : 'cloud',
    autonomous: values.autonomous,
    now,
    env: process.env,
  })
  process.stdout.write(`${JSON.stringify(stage, null, 2)}\n`)
  // Every stage but 'end' is a pending ask the human or a subagent still answers: exit 0 so a
  // caller's `&&` chain goes on to read it, never treating "there is a question" as a failure.
  // 'end' is the run's own final word: its `status` is build-feature's run status for the reason
  // the run ended (build-status.ts, F20), and the exit follows A2 on it.
  if (stage.stage === 'end') return exitCodeFor(typeof stage.status === 'string' ? (stage.status as RunStatus) : buildRunStatus({ kind: 'unexpected-error' }).status)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`build-feature: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
