// The review context on the host, and the shared prefix built from it. load-pr writes one
// context file per root session (the packet, the shas, the personas, the cost history); each
// seat session's hook records which root it belongs to; and each seat session's dynamic system
// instruction (shared-prefix-instructions.ts) reads the context through that pointer and returns
// sharedPrefix(pr) as its whole system prompt. Node fs lives here and in nothing the workflow
// body imports: pr-debator reaches it only through "use step" functions.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedPrefix } from './review.ts'
import { prContextFrom } from './review-context.ts'
import { contextFileSchema, type ReviewContextFile } from './target.ts'

export { personaOf, prContextFrom } from './review-context.ts'

export const CONTEXT_DIR = join(tmpdir(), 'pr-reviewer-context')

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, '_')

/** The root session's context file. load-pr runs in the root session, so its session id is the key. */
export const contextFileFor = (rootSessionId: string) => join(CONTEXT_DIR, `${safe(rootSessionId)}.json`)

/** The pointer a seat session's hook leaves: which root session it reviews for. */
export const pointerFor = (sessionId: string) => join(CONTEXT_DIR, 'by-session', safe(sessionId))

export async function writeContext(rootSessionId: string, context: ReviewContextFile): Promise<string> {
  const path = contextFileFor(rootSessionId)
  await mkdir(CONTEXT_DIR, { recursive: true })
  await writeFile(path, JSON.stringify(context), 'utf8')
  return path
}

/** The context file, validated; null when it is not there. */
export async function readContext(path: string): Promise<ReviewContextFile | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  return contextFileSchema.parse(JSON.parse(text))
}

export async function rememberSession(sessionId: string, rootSessionId: string): Promise<void> {
  await mkdir(join(CONTEXT_DIR, 'by-session'), { recursive: true })
  await writeFile(pointerFor(sessionId), rootSessionId, 'utf8')
}

export async function forgetSession(sessionId: string): Promise<void> {
  await rm(pointerFor(sessionId), { force: true })
}

/**
 * The shared prefix for a seat session: the pointer its hook left, the root's context, the
 * prefix. Null when the session has no pointer: it is not a seat of a loaded review.
 */
export async function sharedPrefixForSession(sessionId: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const rootSessionId = await readFile(pointerFor(sessionId), 'utf8').catch(() => null)
  if (rootSessionId === null) return null
  const context = await readContext(contextFileFor(rootSessionId.trim()))
  if (context === null) throw new Error(`Seat session ${sessionId} points at root session ${rootSessionId.trim()}, but ${contextFileFor(rootSessionId.trim())} is gone. Run load-pr again.`)
  return sharedPrefix(prContextFrom(context, env))
}
