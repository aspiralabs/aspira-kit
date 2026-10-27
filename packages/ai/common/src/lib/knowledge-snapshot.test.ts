// The snapshot section search (KIT-68 review REBA1.3): a page whose own markdown holds a `---` rule must still be
// one section, ending at the next page's heading and not at that rule. A snapshot built from a guidelines folder
// with such a file verifies untouched and is refused when one byte after the inner rule changes, for REQUIRED.md
// alone and for the knowledge folder. Fixtures are temp folders.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseProvenance, verifyKnowledgeDir, verifySnapshot, writeGuidelinesFolder } from './knowledge-snapshot.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A client root with a guidelines folder holding `files`, and the ticket folder the knowledge folder goes under. */
async function client(files: Record<string, string>): Promise<{ guidelines: string; ticketFolder: string; out: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-snapshot-')))
  temps.push(root)
  const guidelines = join(root, 'rules')
  await mkdir(guidelines, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(guidelines, name), text)
  const ticketFolder = join(root, '.work', 'nom-4-x')
  await mkdir(ticketFolder, { recursive: true })
  return { guidelines, ticketFolder, out: join(ticketFolder, 'knowledge') }
}

const RULED = 'intro\n\n---\n\nmore **REV-001 — MUST** x\n'
const A = '**A-001 — MUST** a second.\n'

describe('the section search on a page holding its own --- rule (REBA1.3)', () => {
  it('verifies the untouched snapshot and refuses one byte changed after the inner ---', async () => {
    const { guidelines, ticketFolder, out } = await client({ '1-review.md': RULED, 'a.md': A })
    await writeGuidelinesFolder(guidelines, out, { ticketFolder })
    const file = join(out, 'REQUIRED.md')
    const text = await readFile(file, 'utf8')
    expect(text).toContain(RULED.trimEnd())
    const expectedRootId = parseProvenance(text)!.rootId
    expect([(await verifySnapshot(file, { expectedRootId })).ok, (await verifyKnowledgeDir(out, { expectedRootId })).ok]).toEqual([true, true])
    await writeFile(file, text.replace('MUST** x', 'MUST** y'))
    expect([(await verifySnapshot(file, { expectedRootId })).ok, (await verifyKnowledgeDir(out, { expectedRootId })).ok]).toEqual([false, false])
  })
})
