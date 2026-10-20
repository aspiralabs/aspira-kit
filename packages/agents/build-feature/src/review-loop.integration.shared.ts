// The fixtures the review-loop*.integration.test.ts files share (split from one file so the shards balance).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PR_URL, ofKind, project, writeStepExport, type Project, type Result } from './driver.test-helper.ts'

export const exec = promisify(execFile)

export const SLOW = 180_000
export const high = (n: number, file = 'src/a.ts') => [{ id: `H${n}`, severity: 'high' as const, title: `Review ${n} found the retry never stops`, file }]
export const SOURCE = { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "import { a } from './a.ts'\n", 'src/b.ts': 'export const b = 1\n' }

/** A ticket in In Review: Implementation with its PR open; the run does Step 10 and returns the first review stage. */
export async function reviewing(options: { aspira?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const h = await project({ status: 'In Review: Implementation', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...options.files }, ...(options.aspira === undefined ? {} : { aspira: options.aspira }) })
  await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
  return { h, review: await toReview(h, await h.start()) }
}

/** Answer Step 10 when it is asked for and return the next review (or whatever stops the run). */
export async function toReview(h: Project, from?: Result): Promise<Result> {
  let result = await h.advance({}, from)
  while (result.stage?.stage === 'step10') {
    await h.answer(result.stage, { docs: [], docsToPropagate: 'none' })
    result = await h.advance()
  }
  return result
}

/** A fix that changes the given files and reports no decisions. */
export async function fix(h: Project, stage: Result, files: string[]) {
  for (const file of files) await h.write(file, `export const fixed = ${JSON.stringify(file)}\n`)
  await h.answer(stage.stage, { decisions: [], usage: { tokens: 400, wallMs: 15000 } })
}

export const reviewSteps = (h: Project, from = 0) => ofKind(h.stages.slice(from), 'step').filter((stage) => stage.step === 'pr-reviewer')
export const ghRan = async (h: Project, verb: string) => (await h.ghCalls()).filter(({ args }) => args[0] === 'pr' && args[1] === verb).length
