// The provenance header carried at the top of a REQUIRED.md (or any other snapshot file
// knowledge-walk.ts writes through renderRequired's `header` argument): a verifiable record of
// what was fetched, when, from where, and with what content, so a later reader can tell a live
// snapshot from an edited, moved or stale copy without re-fetching Notion. renderProvenance /
// parseProvenance are pure; verifySnapshot / verifyKnowledgeDir and compareSnapshot are the two
// ways a caller uses that record — one against the file on disk, the other against Notion itself.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { NOTION_API, NOTION_VERSION } from './knowledge.ts'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One page as renderProvenance hashes it: `rawMarkdown` is the raw Notion markdown (pre-rewrite, pre-header), `section` is the text whose hash a verifier can later recompute (for a required page, the exact block renderRequired wrote into the body). */
export type ProvenancePage = { id: string; url: string; title: string; file: string; rawMarkdown: string; section: string }

/** The same page once the header has been parsed back: content replaced by its hashes. */
export type ParsedProvenancePage = { id: string; url: string; title: string; file: string; markdownHash: string; sectionHash: string }

export type Provenance = {
  fetchedAt: string
  rootUrl: string
  rootId: string
  /** The absolute path the file carrying this header was written to. */
  path: string
  /** sha256 over every page's `section` concatenated in order: a whole-tree checksum, not just this file's own body. */
  bodyHash: string
  pages: ParsedProvenancePage[]
}

const HEADER_OPEN = '<!-- knowledge-snapshot'
const HEADER_CLOSE = '\n-->'

/** Renders the HTML-comment header block. `pages` is every page the walk wrote (INDEX included), not only the required ones, so a later compareSnapshot can report on any of them. */
export function renderProvenance(input: { fetchedAt: string; rootUrl: string; rootId: string; path: string; pages: ProvenancePage[] }): string {
  const bodyHash = sha256(input.pages.map((p) => p.section).join('\u0000'))
  const payload: Provenance = {
    fetchedAt: input.fetchedAt,
    rootUrl: input.rootUrl,
    rootId: input.rootId,
    path: input.path,
    bodyHash,
    pages: input.pages.map((p) => ({ id: p.id, url: p.url, title: p.title, file: p.file, markdownHash: sha256(p.rawMarkdown), sectionHash: sha256(p.section) })),
  }
  return `${HEADER_OPEN}\n${JSON.stringify(payload, null, 2)}${HEADER_CLOSE}\n`
}

/** Reads the header back off the top of `text`. Returns null when `text` does not begin with a parseable header. */
export function parseProvenance(text: string): Provenance | null {
  if (!text.startsWith(HEADER_OPEN)) return null
  const end = text.indexOf(HEADER_CLOSE)
  if (end === -1) return null
  try {
    const payload: unknown = JSON.parse(text.slice(HEADER_OPEN.length, end).trim())
    if (typeof payload !== 'object' || payload === null) return null
    const p = payload as Record<string, unknown>
    if (typeof p.fetchedAt !== 'string' || typeof p.rootUrl !== 'string' || typeof p.rootId !== 'string' || typeof p.path !== 'string' || typeof p.bodyHash !== 'string' || !Array.isArray(p.pages)) return null
    return payload as Provenance
  } catch {
    return null
  }
}

export type VerifyOk = { ok: true; message: string }
export type VerifyFail = { ok: false; reason: string; hint: string }
export type VerifyResult = VerifyOk | VerifyFail

const HINT = 'Run the load-knowledge command (packages/agents/common/scripts/load-knowledge.ts) to refresh the guidelines snapshot instead of trusting this copy.'

/**
 * Trusts a snapshot only when it sits exactly where it was written, carries an intact header whose
 * per-page hashes match the file's current content, is not under a trace/ folder (a historical
 * record, never a live snapshot), and names the root this run is configured for.
 */
export async function verifySnapshot(path: string, opts: { expectedRootId: string }): Promise<VerifyResult> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return { ok: false, reason: `${path} does not exist or cannot be read.`, hint: HINT }

  const parsed = parseProvenance(text)
  if (parsed === null) return { ok: false, reason: `${path} carries no provenance header; it is not a load-knowledge snapshot.`, hint: HINT }

  const resolvedPath = resolve(path)
  if (resolve(parsed.path) !== resolvedPath) return { ok: false, reason: `${path} does not sit where its header says it was written (${parsed.path}); it has been moved or copied.`, hint: HINT }

  if (resolvedPath.split(sep).includes('trace')) return { ok: false, reason: `${path} sits under a trace/ folder, a historical record, not a live snapshot to trust.`, hint: HINT }

  if (parsed.rootId !== opts.expectedRootId) return { ok: false, reason: `${path} was loaded from root ${parsed.rootId}, but this run is configured for root ${opts.expectedRootId}.`, hint: HINT }

  // Only pages whose section is actually embedded in this file's body (the required ones) can be
  // re-hashed from it alone; a listed page the body never carried is left unverified here.
  const sections = text.split('\n---\n\n').slice(1)
  for (const page of parsed.pages) {
    const section = sections.find((s) => s.startsWith(`# ${page.title}\n\n`))
    if (section === undefined) continue
    if (sha256(section) !== page.sectionHash) return { ok: false, reason: `${page.title} has been edited since it was loaded from Notion (its section no longer matches the recorded hash).`, hint: HINT }
  }

  return { ok: true, message: `${path} passes its integrity checks against its own header. It is unverified against Notion: run compareSnapshot to confirm nothing changed upstream.` }
}

/** The same check against `join(dir, 'REQUIRED.md')`. */
export async function verifyKnowledgeDir(dir: string, opts: { expectedRootId: string }): Promise<VerifyResult> {
  return verifySnapshot(join(dir, 'REQUIRED.md'), opts)
}

export type ComparePage = { id: string; title: string; url: string }
export type NotComparedPage = ComparePage & { reason: string }
export type CompareResult =
  | { comparable: true; changed: ComparePage[]; notCompared: NotComparedPage[]; message: string }
  | { comparable: false; reason: string }

/** Refetches every page the header lists and compares its raw markdown's sha256 to the recorded markdownHash. */
export async function compareSnapshot(text: string, deps: { token: string; api?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): Promise<CompareResult> {
  const parsed = parseProvenance(text)
  if (parsed === null) return { comparable: false, reason: 'The text carries no provenance header; the comparison was not made.' }

  const api = deps.api ?? NOTION_API
  const request = deps.fetch ?? fetch
  const headers = { Authorization: `Bearer ${deps.token}`, 'Notion-Version': NOTION_VERSION }

  const changed: ComparePage[] = []
  const notCompared: NotComparedPage[] = []
  let unreachable = 0
  for (const page of parsed.pages) {
    let res: Response
    try {
      res = await request(`${api}/pages/${page.id}/markdown`, { headers })
    } catch (error) {
      unreachable += 1
      notCompared.push({ id: page.id, title: page.title, url: page.url, reason: `could not reach Notion: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (!res.ok) {
      notCompared.push({ id: page.id, title: page.title, url: page.url, reason: `Notion ${res.status}` })
      continue
    }
    const body = (await res.json()) as { markdown?: string }
    if (sha256(body.markdown ?? '') !== page.markdownHash) changed.push({ id: page.id, title: page.title, url: page.url })
  }

  if (parsed.pages.length > 0 && unreachable === parsed.pages.length) {
    return { comparable: false, reason: `Notion could not be reached for any of the ${parsed.pages.length} page(s); the comparison was not made.` }
  }

  const names = notCompared.map((p) => p.title).join(', ')
  const message = `${changed.length} changed, ${notCompared.length} not compared${notCompared.length > 0 ? ` (${names})` : ''}`
  return { comparable: true, changed, notCompared, message }
}
