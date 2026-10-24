import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readRunStatus } from '@aspiralabs/ai/common/lib/run-status'

// The separate-process implementor (implementor.sh's RUNNER) captures the whole invoke run into a
// log file and greps it for a bare status line (implementor.sh:262-271). This is the same idea
// done properly: read the agent's own reported status and branch out of that log, map the status
// word through readRunStatus (so one of its old per-skill words still reads as the new ready), and
// write plan.review/trace/implementation-local.json in the same shape the --local driver's own
// export uses (`mode` tells them apart), so RUN_RECORDS.implementor's reader sees one format
// regardless of which path produced the run (F21).

const usage = 'Usage: node export-record.ts --log <run log path> --export <plan.review directory>'

/** A "Status: <word>" or `"status": "<word>"` line, the label case-insensitive, markdown emphasis allowed around the word. The first one in the log wins. */
const STATUS_LINE = /^[ \t]*(?:"status"\s*:\s*"([a-z][a-z-]*)"|status:?\s*\*{0,2}([a-z][a-z-]*)\*{0,2})/im
/** A "Branch: <name>" or `"branch": "<name>"` line, the same shape as the status line. */
const BRANCH_LINE = /^[ \t]*(?:"branch"\s*:\s*"([^"]+)"|branch:?\s*\*{0,2}(\S+?)\*{0,2}[ \t]*$)/im

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text)
  if (match === null) return null
  return (match[1] ?? match[2] ?? '').trim() || null
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { log: { type: 'string' }, export: { type: 'string' } } })
  if (values.log === undefined || values.export === undefined) throw new Error(usage)
  const log = await readFile(values.log, 'utf8').catch(() => '')
  const word = firstMatch(log, STATUS_LINE)
  const read = word === null ? null : readRunStatus(word)
  const status = read?.status ?? 'incomplete'
  const reasonCode = read?.reasonCode ?? null
  const reason = read !== null ? null : word === null ? `${values.log} has no reported status line.` : `${values.log}'s reported status "${word}" is not a known run status.`
  const branch = firstMatch(log, BRANCH_LINE)
  const traceDir = join(values.export, 'trace')
  await mkdir(traceDir, { recursive: true })
  const trace = { mode: 'separate', status, reason, reasonCode, branch }
  await writeFile(join(traceDir, 'implementation-local.json'), JSON.stringify(trace, null, 2))
  console.log(JSON.stringify({ status, reasonCode, branch }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(`export-record: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
