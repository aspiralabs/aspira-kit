// The spend of a run, on the host. The usage hook adds every priced model call here from the app
// runtime, and pr-debator's "use step" reads it back. A file, not module state: eve bundles the
// step functions into their own module graph, so a Map in budget.ts is one instance for the hook
// and another for the step, and the step would read zero forever. One file per root session,
// one line per call, appended, under the OS temp directory; both sides run on this host.

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Spend = { costUsd: number; calls: number; unpriced: number }

export const SPEND_DIR = join(tmpdir(), 'pr-reviewer-spend')

const file = (rootSessionId: string) => join(SPEND_DIR, `${rootSessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`)

/** One model call's reported cost, appended to its root session's ledger. A null cost is counted but adds nothing. */
export async function recordSpend(rootSessionId: string, costUsd: number | null): Promise<void> {
  await mkdir(SPEND_DIR, { recursive: true })
  await appendFile(file(rootSessionId), `${JSON.stringify({ costUsd })}\n`, 'utf8')
}

/** The ledger summed. A root session with no ledger has spent nothing. */
export async function spentSoFar(rootSessionId: string): Promise<Spend> {
  const text = await readFile(file(rootSessionId), 'utf8').catch(() => '')
  const spend: Spend = { costUsd: 0, calls: 0, unpriced: 0 }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let cost: unknown
    try {
      cost = (JSON.parse(line) as { costUsd?: unknown }).costUsd
    } catch {
      continue // a torn line from a concurrent append
    }
    spend.calls += 1
    if (typeof cost === 'number' && Number.isFinite(cost)) spend.costUsd += cost
    else spend.unpriced += 1
  }
  return spend
}

export async function forgetSpend(rootSessionId: string): Promise<void> {
  await rm(file(rootSessionId), { force: true })
}
