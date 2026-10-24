// Run telemetry for /aspira-build-feature (KIT-19 plan P7: T23-T31) at seam S1: the driver CLI
// `scripts/local.ts <ID>` as `build-feature.sh local` runs it, through driver.test-helper.ts
// project(), observed through the stages it prints and the files it leaves in the ticket folder:
// `telemetry/<run-id>.json` (OTLP JSON), `.local/telemetry/` (run-id markers and the attach record),
// state.json and build-summary.md. Only the boundaries are stood in for (TEST-007): a real temp git
// repository with a bare origin, a fake gh on PATH, time through BUILD_FEATURE_NOW (setNow), the
// Notion answers the session would write as stage answer files, and the step agents' usage files
// written as literal fixtures with their modification time set inside (or outside) the step.
// NOTION_TOKEN is never passed to the driver.
//
// The stage contract added here (beside the one driver.test-helper.ts describes):
//   - step: the printed `command` (and the command in the step prompt) ends with
//     `--parent-run <runId>:<nonce>`; nothing stored keeps it.
//   - telemetry: printed after the Build Summary push when the fetched board rules list the run
//     telemetry file on the BOARD-003 line; `notion: [{ op: 'write', target: 'ticket' }]`; the session
//     answers { attached: true, blockId } or { error }. The attach is recorded at
//     `.local/telemetry/attached/<runId>.json` ({ runId, blockId }).
//   - end: a telemetry file that is not attached adds `Telemetry not attached: <reason>; the file is at <path>`.
//   - a run refuses (exit 1, no stage) before its first step when a step skill's
//     `.claude/skills/aspira-<step>/.kit-version` is missing or differs from this package's version.
// Span attributes read here: aspira.status, aspira.duration_ms, aspira.orchestration.duration_ms,
// aspira.segment, aspira.not_measured, aspira.gap, aspira.partial, aspira.usage_scope,
// aspira.tokens.input, aspira.tokens.output, aspira.tokens.total, aspira.cost_usd, and a model attribute.

import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, project } from './driver.test-helper.ts'
import { SLOW, kitVersions, commandValues, stopWith } from './telemetry.integration.shared.ts'

afterAll(cleanup)

describe('KIT-19 T24 F6: every printed step command carries --parent-run <runId>:<nonce>, and nothing stored does', () => {
  it.each(['local', 'cloud'] as const)('ends the %s step command and the command in its prompt with --parent-run', async (mode) => {
    const h = await project({ status: 'Ready: Spec', mode, files: kitVersions() })
    const step = await h.advance({}, await h.start())
    const suffix = ` --parent-run ${String(step.stage?.runId)}:${String(step.stage?.nonce)}`
    const prompt = await readFile(String(step.stage?.prompt), 'utf8').catch(() => '')
    expect({
      stage: step.stage?.stage,
      command: String(step.stage?.command).endsWith(suffix),
      // KIT-2 (F44): the prompt names the launcher form, not the slash command; the launcher line carries the suffix.
      prompt: prompt.split('\n').some((line) => line.includes('/scripts/planner.sh') && line.endsWith(suffix)),
    }).toEqual({ stage: 'step', command: true, prompt: true })
  }, SLOW)

  it.each(['local', 'cloud'] as const)('keeps --parent-run and the nonce out of every command in state.json and out of build-summary.md (%s)', async (mode) => {
    const h = await project({ status: 'Ready: Spec', mode, files: kitVersions() })
    const step = await h.advance({}, await h.start())
    const nonce = String(step.stage?.nonce)
    await h.report(step.stage, 'ready')
    await h.next()
    await stopWith(h)
    const commands = commandValues(await h.state())
    const summary = await h.summary()
    expect({
      printed: String(step.stage?.command).includes('--parent-run'),
      commands: commands.length > 0,
      stored: commands.filter((command) => command.includes('--parent-run') || command.includes(nonce)),
      summary: summary.includes('--parent-run') || summary.includes(nonce),
    }).toEqual({ printed: true, commands: true, stored: [], summary: false })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T25: the step skills must be from the driver's kit version.
// ---------------------------------------------------------------------------------------------
