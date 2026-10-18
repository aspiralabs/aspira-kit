// Live resolution of the card. The driver never reads Status from ticket.md: it prints a `resolve`
// stage with a fresh nonce, the session reads the card with the Notion MCP and writes the answer,
// and only an answer carrying the pending nonce is accepted. With NOTION_TOKEN set the driver runs
// agent-common's resolve-ticket script instead. The card is resolved again after every step and
// before every move (F49); a move goes ahead only when Status, Dev and PR are what the run expects.

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Card } from '#src/run-state.ts'

const exec = promisify(execFile)

const nonce = z.string().min(1)

/** What the session writes for a resolve stage: the card, a not-found, or the error it got. */
export const resolutionSchema = z.union([
  z.object({ nonce, error: z.string().min(1) }),
  z.object({ nonce, found: z.literal(false), id: z.string().optional() }),
  z.object({ nonce, found: z.literal(true), id: z.string().min(1), title: z.string(), url: z.string(), status: z.string().min(1), pr: z.string().nullable(), dev: z.string().nullable(), type: z.string().nullable().optional() }),
])

export type ResolveStageInput = { id: string; board: string; output: string; move?: { from: string; to: string } }

/** The stage body: read the card with the Notion MCP and write the resolution file. */
export function resolveStage(input: ResolveStageInput): Record<string, unknown> {
  const { id, board, output, move } = input
  return {
    id,
    board,
    ...(move === undefined ? {} : { move }),
    notion: [{ op: 'read', target: 'ticket' }],
    instructions: `Read ${id} on the Feature Board ${board} with the Notion MCP (notion-fetch, read-only): its Status, PR, Dev and Type properties as the board shows them now, never from ticket.md. Write {"nonce", "found": true, "id", "title", "url", "status", "pr", "dev", "type"} (pr, dev and type null when empty) to ${output}; {"nonce", "found": false, "id"} when the board has no such ticket; {"nonce", "error"} when the board cannot be read.`,
  }
}

export type Resolution = { kind: 'pending'; why: string } | { kind: 'card'; card: Card } | { kind: 'stop'; message: string; notFound?: true }

/** Accept a resolution answer only when it carries the pending nonce. */
export function acceptResolution(answer: unknown, pendingNonce: string, context: { id: string; board: string }): Resolution {
  const parsed = resolutionSchema.safeParse(answer)
  if (!parsed.success) return { kind: 'stop', message: `the resolution of ${context.id} is not a card, a not-found or an error: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` }
  const value = parsed.data
  if (value.nonce !== pendingNonce) return { kind: 'pending', why: `the resolution carries nonce ${value.nonce}, not the pending ${pendingNonce}` }
  if ('error' in value) return { kind: 'stop', message: `the board could not be reached to resolve ${context.id}: ${value.error}` }
  if (!value.found) return { kind: 'stop', message: `ticket ${context.id} not found on the board ${context.board}`, notFound: true }
  const { id, title, url, status, pr, dev } = value
  const type = value.type === undefined || value.type === null || value.type.trim() === '' ? null : value.type.trim()
  return { kind: 'card', card: { id, title, url, status, pr: pr === '' ? null : pr, dev: dev === '' ? null : dev, type } }
}

/** What differs between the card the run expects and the card it read; empty when they agree. */
export function cardDifferences(expected: Pick<Card, 'status' | 'pr' | 'dev'>, actual: Card): string[] {
  const out: string[] = []
  if (actual.status !== expected.status) out.push(`Status is ${actual.status}, expected ${expected.status}`)
  if ((actual.dev ?? null) !== (expected.dev ?? null)) out.push(`Dev is ${actual.dev ?? 'empty'}, expected ${expected.dev ?? 'empty'}`)
  if ((actual.pr ?? null) !== (expected.pr ?? null)) out.push(`PR is ${actual.pr ?? 'empty'}, expected ${expected.pr ?? 'empty'}`)
  return out
}

/** agent-common's resolve-ticket script, which reads the board with NOTION_TOKEN. */
function resolveScript(): string {
  const board = fileURLToPath(import.meta.resolve('@aspiralabs/agent-common/lib/board'))
  return join(dirname(board), '..', '..', 'scripts', 'resolve-ticket.ts')
}

/** Resolve the card with NOTION_TOKEN through agent-common's script (no session stage). */
export async function resolveWithToken(context: { id: string; board: string; repo: string; env: NodeJS.ProcessEnv }): Promise<Resolution> {
  const outcome = await exec(process.execPath, [...process.execArgv, resolveScript(), context.id, '--board', context.board], { cwd: context.repo, env: context.env }).then(
    ({ stdout }) => ({ ok: true as const, stdout }),
    (error: { stderr?: string; message?: string }) => ({ ok: false as const, stderr: error.stderr ?? error.message ?? 'resolve-ticket failed' }),
  )
  if (!outcome.ok) {
    const reason = outcome.stderr.trim()
    if (/not found|no ticket/i.test(reason)) return { kind: 'stop', message: `ticket ${context.id} not found on the board ${context.board}: ${reason}`, notFound: true }
    return { kind: 'stop', message: `the board could not be reached to resolve ${context.id}: ${reason}` }
  }
  const fields = Object.fromEntries(
    outcome.stdout
      .split('\n')
      .map((line) => /^([a-z]+)=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!]),
  )
  return acceptResolution({ nonce: 'token', found: true, id: fields.id ?? context.id, title: fields.title ?? '', url: fields.url ?? '', status: fields.status ?? '', pr: fields.pr || null, dev: fields.dev || null, type: fields.type || null }, 'token', context)
}
