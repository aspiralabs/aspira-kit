// A --guidelines snapshot for tests, in the exact shape load-knowledge writes (F50): REQUIRED.md's
// sections under a provenance header that records the file's own path and each section's hash, so
// verifySnapshot accepts it where it was written and refuses it once it is moved or edited.

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pageIdFrom, renderRequired, type LoadedPage } from '@aspiralabs/ai/common/lib/knowledge'
import { renderProvenance } from '@aspiralabs/ai/common/lib/knowledge-snapshot'

/** The knowledge root the snapshots below were "loaded" from. */
export const SNAPSHOT_ROOT = 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef'

const page = (title: string, id: string, markdown: string): LoadedPage => ({ id, title, url: `https://www.notion.so/${title.replaceAll(' ', '-')}-${id.replaceAll('-', '')}`, markdown })

/** The two required pages every agent ingests by default; one rule id, so a review covering REV-001 covers the snapshot. */
export const SNAPSHOT_PAGES: LoadedPage[] = [
  page('Agent Instructions', '11111111-1111-1111-1111-111111111111', 'REV-001 Check the spec'),
  page('Review Verification', '22222222-2222-2222-2222-222222222222', 'Verify every claim before it is cited.'),
]

/** Writes a verified REQUIRED.md snapshot at `file` and returns its text. */
export async function writeSnapshot(file: string, pages: LoadedPage[] = SNAPSHOT_PAGES, root: string = SNAPSHOT_ROOT): Promise<string> {
  const path = resolve(file)
  const fetchedAt = '2026-10-15T00:00:00.000Z'
  const header = renderProvenance({
    fetchedAt,
    rootUrl: root,
    rootId: pageIdFrom(root) ?? '',
    path,
    pages: pages.map((p) => ({ id: p.id, url: p.url, title: p.title, file: 'REQUIRED.md', rawMarkdown: p.markdown, section: `# ${p.title}\n\n<!-- ${p.url} -->\n\n${p.markdown.trim()}\n` })),
  })
  const text = renderRequired(pages, fetchedAt, header)
  await writeFile(path, text)
  return text
}
