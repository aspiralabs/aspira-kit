// The build-feature driver, as `build-feature.sh local` runs it:
//   local.ts <ID> [--cloud] [--repo <dir>] [--run <runId>] [--force-run] [--finish] [--no-ticket] [--no-comment] [--approve <step> --reason "<why>"]
// --approve (KIT-83): the author accepts the spec-writer's or planner's output as it is now and the run goes on past
// that step; only the human types it, on a new invocation, and the driver records it (never a session).
// By default every step runs its skill in this session; with --cloud every step runs its skill's
// cloud agent, started and waited on (F2, Q10 revised; KIT-51). --local is accepted and means the default.
// Prints exactly one stage as JSON on stdout and exits 0, except the `end` stage, which exits by
// its run status (A2); a refusal prints its message on stderr and exits 1. Time comes from BUILD_FEATURE_NOW when set (tests), else the clock.

import { parseArgs } from 'node:util'
import { APPROVABLE_OUTPUTS, isApprovableStep } from '@aspiralabs/ai/common/lib/author-approval'
import { exitCodeFor, type RunStatus } from '@aspiralabs/ai/common/lib/run-status'
import { buildRunStatus } from '#build-feature/build-status.ts'
import { nextStage, Refusal } from '#build-feature/driver.ts'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      local: { type: 'boolean', default: false },
      cloud: { type: 'boolean', default: false },
      repo: { type: 'string' },
      run: { type: 'string' },
      'force-run': { type: 'boolean', default: false },
      finish: { type: 'boolean', default: false },
      autonomous: { type: 'boolean', default: false },
      'no-ticket': { type: 'boolean', default: false },
      'no-comment': { type: 'boolean', default: false },
      approve: { type: 'string' },
      reason: { type: 'string' },
    },
  })
  const [id] = positionals
  if (id === undefined || !/^[A-Za-z]+-\d+$/.test(id)) throw new Refusal('Usage: local.ts <ID> [--cloud] [--autonomous] [--run <runId>] [--force-run] [--finish]; <ID> is the Feature Board ticket ID, for example KIT-11.')
  if (values.local && values.cloud) throw new Refusal('--local and --cloud name opposite modes; pass --cloud for the cloud agents, or nothing for this session (the default)')
  if ((values.approve === undefined) !== (values.reason === undefined) || (values.reason !== undefined && values.reason.trim() === '')) throw new Refusal('--approve <step> and --reason "<why>" go together: name the step whose output you approve and say why')
  if (values.approve !== undefined && !isApprovableStep(values.approve)) throw new Refusal(`--approve takes ${Object.keys(APPROVABLE_OUTPUTS).join(' or ')}, the steps whose output an author can approve; not "${values.approve}"`)
  const now = process.env.BUILD_FEATURE_NOW !== undefined && process.env.BUILD_FEATURE_NOW !== '' ? process.env.BUILD_FEATURE_NOW : new Date().toISOString()
  const stage = await nextStage({
    id: id.toUpperCase(),
    repo: values.repo ?? process.cwd(),
    ...(values.run === undefined ? {} : { run: values.run }),
    forceRun: values['force-run'],
    finish: values.finish,
    mode: values.cloud ? 'cloud' : 'local',
    autonomous: values.autonomous,
    ...(values['no-ticket'] ? { noTicket: true } : {}),
    ...(values.approve !== undefined && isApprovableStep(values.approve) && values.reason !== undefined ? { approve: { step: values.approve, reason: values.reason.trim() } } : {}),
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
