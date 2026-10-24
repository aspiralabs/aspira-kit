// A separate-process review (the eve launcher, not --local) ends with whatever the agent itself
// wrote: trace/review.json when a session finished cleanly, nothing when the sandboxed run died
// mid-way (a crash, a timeout, eve's own failure) before it got to write one. The launcher's RUNNER
// calls this after the run and before `ticket.ts finish`, so finish always has a run record to read
// (F6, F21): when the agent already left one, this makes no change; otherwise it writes one from
// what the launcher does know for certain — the eve process's own exit code, and whatever review.md
// and findings.md the sandboxed run left in the export directory before it stopped.
//
//   node scripts/export-record.ts --output <export-dir> --exit-code <N>

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { countsFromFindings } from '@aspiralabs/ai/common/lib/findings-counts'
import { exitCodeFor, type RunStatus } from '@aspiralabs/ai/common/lib/run-status'
import { verdictFrom } from '../agent/lib/review.ts'

const usage = 'Usage: node scripts/export-record.ts --output <export-dir> --exit-code <N>'

/** The run record this writes, in the same shape --local's exportReview writes to trace/review.json. */
export type ExportRecord = { status: RunStatus; reason: string | null; reasonCode: null; verdict: ReturnType<typeof verdictFrom> | null; counts: ReturnType<typeof countsFromFindings> }

/**
 * The record for a separate-process run, from what the launcher knows: the eve process's exit
 * code, and review.md/findings.md if the sandboxed run got far enough to write them. Ready only on
 * exit 0 with review.md present; otherwise incomplete, with a one-sentence reason naming which of
 * the two is missing.
 */
export async function recordFor(outputDir: string, exitCode: number): Promise<ExportRecord> {
  const review = await readFile(join(outputDir, 'review.md'), 'utf8').catch(() => null)
  const findingsText = await readFile(join(outputDir, 'findings.md'), 'utf8').catch(() => null)
  const counts = findingsText === null ? null : countsFromFindings(findingsText)
  const verdict = counts === null ? null : verdictFrom(counts)
  if (exitCode === 0 && review !== null) return { status: 'ready', reason: null, reasonCode: null, verdict, counts }
  const reason = exitCode !== 0 ? `the eve agent exited ${exitCode}` : `${outputDir}/review.md is missing`
  return { status: 'incomplete', reason, reasonCode: null, verdict, counts }
}

/** Writes trace/review.json for a separate-process run that left none; a no-op when the agent already wrote one. */
export async function writeRecordIfMissing(outputDir: string, exitCode: number): Promise<{ wrote: boolean; record: ExportRecord }> {
  const path = join(outputDir, 'trace', 'review.json')
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing !== null) return { wrote: false, record: JSON.parse(existing) as ExportRecord }
  const record = await recordFor(outputDir, exitCode)
  await mkdir(join(outputDir, 'trace'), { recursive: true })
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8')
  return { wrote: true, record }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'exit-code': { type: 'string' } } })
  if (values.output === undefined || values['exit-code'] === undefined) {
    console.error(usage)
    process.exitCode = 2
    return
  }
  const exitCode = Number(values['exit-code'])
  if (!Number.isInteger(exitCode)) {
    console.error(`${usage}\n--exit-code must be a whole number`)
    process.exitCode = 2
    return
  }
  const { wrote, record } = await writeRecordIfMissing(values.output, exitCode)
  console.log(JSON.stringify({ wrote, ...record }, null, 2))
  process.exitCode = exitCodeFor(record.status)
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href
if (isMain) await main()
