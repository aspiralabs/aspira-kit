// T54 (F40): knowledge-snapshot.ts does not exist yet (P26). This file is its provenance contract:
// renderRequired (knowledge.ts) will build REQUIRED.md's header from this module, but the header
// itself only needs the facts a write-up like this covers — so it is tested directly, against
// every page the walk wrote, not only the required ones (REQUIRED.md's body holds the required
// pages' text, but its header is the provenance of the whole tree, so a later verify or compare
// can check a page that was never "required").
//
// renderProvenance({ fetchedAt, rootUrl, rootId, path, pages }) renders an HTML-comment header
// block recording: the fetch time, the root page's URL and id, the absolute path the file was
// written to, a sha256 `bodyHash` over every page's `section` concatenated in order, and one line
// per page: id, url, title, file, a sha256 `markdownHash` of that page's raw (pre-rewrite) Notion
// markdown, and a sha256 `sectionHash` of that page's `section` text. `pages` is every page the
// walk wrote (INDEX included), in order, each `{ id, url, title, file, rawMarkdown, section }`.
//
// parseProvenance(text) reads the header back off the top of `text` (the rendered REQUIRED.md, or
// any file that begins with one): the same fields renderProvenance recorded, with `pages[]` giving
// `markdownHash`/`sectionHash` instead of the content they were computed from. Returns null when
// `text` does not begin with a parseable header.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseProvenance, renderProvenance, type ProvenancePage } from './knowledge-snapshot'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The shape parseProvenance gives back for one page: ProvenancePage's content fields replaced by their hashes. */
type ParsedPage = { id: string; url: string; title: string; file: string; markdownHash: string; sectionHash: string }

function page(overrides: Partial<ProvenancePage> & Pick<ProvenancePage, 'id' | 'title' | 'file'>): ProvenancePage {
  return {
    url: `https://www.notion.so/${overrides.title.replace(/\s+/g, '-')}-${overrides.id.replace(/-/g, '')}`,
    rawMarkdown: `Raw Notion markdown for ${overrides.title}.`,
    section: `# ${overrides.title}\n\nRendered section for ${overrides.title}.\n`,
    ...overrides,
  }
}

const INDEX = page({ id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'Engineering', file: 'INDEX.md' })
const AGENT_INSTRUCTIONS = page({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Agent Instructions', file: 'agent-instructions.md' })
const REVIEW_VERIFICATION = page({ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Review Verification', file: 'review-verification.md' })
// Not in anyone's required list, but still walked and written: the header must still cover it.
const TOPIC_A = page({ id: 'aaaaaaaa-0000-4000-8000-000000000003', title: 'Topic A', file: 'topic-a.md' })

const ROOT_URL = 'https://www.notion.so/Engineering-aaaaaaaa0000400080000000000000'
const ROOT_ID = INDEX.id
const PATH = '/repo/.work/kit-2-x/knowledge/REQUIRED.md'

describe('renderProvenance / parseProvenance', () => {
  it('records the time, the root page URL and id, and per page id/URL/title/file/markdownHash/sectionHash', () => {
    const pages = [INDEX, AGENT_INSTRUCTIONS, REVIEW_VERIFICATION, TOPIC_A]
    const header = renderProvenance({ fetchedAt: '2026-10-15T03:40:00.000Z', rootUrl: ROOT_URL, rootId: ROOT_ID, path: PATH, pages })
    const parsed = parseProvenance(header)
    expect(parsed).not.toBeNull()
    expect(parsed?.fetchedAt).toBe('2026-10-15T03:40:00.000Z')
    expect(parsed?.rootUrl).toBe(ROOT_URL)
    expect(parsed?.rootId).toBe(ROOT_ID)
    expect(parsed?.path).toBe(PATH)
    expect(parsed?.pages.map((p: ParsedPage) => p.id).sort()).toEqual(pages.map((p) => p.id).sort())
    const reviewVerification = parsed?.pages.find((p: ParsedPage) => p.id === REVIEW_VERIFICATION.id)
    expect(reviewVerification).toMatchObject({ url: REVIEW_VERIFICATION.url, title: 'Review Verification', file: 'review-verification.md' })
    expect(reviewVerification?.markdownHash).toBe(sha256(REVIEW_VERIFICATION.rawMarkdown))
    expect(reviewVerification?.sectionHash).toBe(sha256(REVIEW_VERIFICATION.section))
  })

  it('keeps the raw-markdown hash the same across two fetches at different times, for unchanged raw markdown', () => {
    const pages = [INDEX, AGENT_INSTRUCTIONS]
    const first = parseProvenance(renderProvenance({ fetchedAt: '2026-10-15T03:40:00.000Z', rootUrl: ROOT_URL, rootId: ROOT_ID, path: PATH, pages }))
    const second = parseProvenance(renderProvenance({ fetchedAt: '2026-10-16T09:00:00.000Z', rootUrl: ROOT_URL, rootId: ROOT_ID, path: PATH, pages }))
    expect(first?.fetchedAt).not.toBe(second?.fetchedAt)
    const hashesOf = (parsed: typeof first) => parsed!.pages.map((p: ParsedPage) => ({ id: p.id, markdownHash: p.markdownHash })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))
    expect(hashesOf(first)).toEqual(hashesOf(second))
  })

  it('lists every page the walk wrote, including one that is not on anyone\'s required list', () => {
    const header = renderProvenance({ fetchedAt: '2026-10-15T03:40:00.000Z', rootUrl: ROOT_URL, rootId: ROOT_ID, path: PATH, pages: [INDEX, AGENT_INSTRUCTIONS, REVIEW_VERIFICATION, TOPIC_A] })
    const parsed = parseProvenance(header)
    expect(parsed?.pages.some((p: ParsedPage) => p.id === TOPIC_A.id && p.title === 'Topic A')).toBe(true)
  })

  it('returns null for text with no parseable header', () => {
    expect(parseProvenance('# Just a document\n\nNo header here.\n')).toBeNull()
    expect(parseProvenance('')).toBeNull()
  })
})
