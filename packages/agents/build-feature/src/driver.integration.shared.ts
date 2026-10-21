// The helpers the driver-*.integration.test.ts files share (split from one file so the shards balance).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DECISIONS_FILE, kinds, taken, type DecisionFixture, type Handler, type Project, type Result, type Stage } from './driver.test-helper.ts'

export const SLOW = 120_000
export const returnOn = (...names: string[]) => Object.fromEntries(names.map((name) => [name, async () => 'return' as const]))
/** A handler that answers the first stage it sees and hands back the next one of its kind. */
export const once = (answer: (stage: Stage) => Promise<void>): Handler => {
  let done = false
  return async (stage) => {
    if (done) return 'return'
    done = true
    await answer(stage)
  }
}
export const lastLine = (text: unknown) => String(text ?? '').trimEnd().split('\n').at(-1)
export const firstLine = (text: unknown) => String(text ?? '').trimStart().split('\n')[0]
export const noStepOrMove = (h: Project) => !kinds(h.stages).some((kind) => kind === 'step' || kind === 'move')
export const moveOf = (stage: Stage | null) => (stage?.stage === 'move' ? { from: stage.from, to: stage.to } : { stage: stage?.stage ?? 'no stage' })
// The step command without the run's own flags: the trailing --parent-run <run>:<nonce> (KIT-19) and the
// --guidelines, --knowledge and --packet files the run adds per step (KIT-48), which these tests do not pin.
export const commandOf = (result: Result) => (result.stage?.stage === 'step' ? String(result.stage.command).replace(/ --parent-run \S+$/, '').replace(/ --(?:guidelines|knowledge|packet) \S+/g, '') : `<${result.stage?.stage ?? 'no stage'}>`)
/** Everything the run told the session at the end: the last stage, the output and the summary file. */
export const told = async (h: Project, result: Result) => `${result.text}\n${JSON.stringify(result.stage)}\n${await h.summary()}`

export const PLANNER_DECISIONS = [taken('D1', 'Should the summary list costs per step?'), taken('D2', 'Should the timeline use wall time?')]
export const IMPLEMENTOR_ASSUMPTIONS = [taken('A1', 'Should the gate run in the app directory?')]
export const SUCCESS: Record<string, string> = { groomer: 'confirmed', 'spec-writer': 'ready', planner: 'ready', implementor: 'complete', 'code-analyzer': 'clean', 'pr-reviewer': 'complete' }

/** Start at Ready: Spec and run the planner (D1, D2) and the implementor (A1) up to the next stage after the build. */
export async function plannedAndBuilt(h: Project): Promise<Result> {
  const planner = await h.advance({}, await h.start())
  await h.report(planner.stage!, 'ready', { decisions: PLANNER_DECISIONS })
  const implementor = await h.advance()
  await h.report(implementor.stage!, 'complete', { decisions: IMPLEMENTOR_ASSUMPTIONS })
  return h.advance()
}

/**
 * Run every stage with each step succeeding until `stopAt` (or the end), snapshotting each step's
 * trace/decisions.md right after the step wrote it.
 */
export async function pipeline(h: Project, stopAt?: string) {
  const written = new Map<string, Buffer>()
  const handlers = stopAt === undefined ? {} : returnOn(stopAt)
  let result = await h.advance(handlers, await h.start())
  for (let turn = 0; turn < 20; turn += 1) {
    const stage = result.stage
    if (stage === null || stage.stage === 'end' || stage.stage === stopAt) return { result, written }
    if (stage.stage === 'step') {
      const step = String(stage.step)
      const decisions: Record<string, DecisionFixture[]> = { 'spec-writer': [taken('D1', 'Should the summary be pushed?')], planner: PLANNER_DECISIONS, implementor: IMPLEMENTOR_ASSUMPTIONS }
      await h.report(stage, SUCCESS[step] ?? 'complete', { decisions: decisions[step] ?? [] })
      const file = DECISIONS_FILE[step]
      if (file !== undefined) written.set(file, await readFile(join(h.folder, file)))
    } else if (stage.stage === 'step10') await h.answer(stage, { docs: [], docsToPropagate: 'none' })
    else if (stage.stage === 'gate') await h.answer(stage, { results: ((stage.commands ?? []) as string[]).map((command) => ({ command, exitCode: 0, output: 'ok' })) })
    else return { result, written }
    result = await h.advance(handlers)
  }
  return { result, written }
}
