// The guidelines snapshot built from a folder (KIT-68, F9 and F10): with `guidelines`, every .md file of the client's
// folder, in plain code-unit file-name order, becomes the REQUIRED.md the steps read, with the provenance header a
// Notion snapshot carries (rootUrl and rootId naming the folder, one hash per file), an INDEX.md listing the files,
// and the same two verifiers accepting it. A missing folder, a folder with no markdown and a folder whose markdown
// holds no REV-001 are refused, naming the folder. Fixtures are temp folders.
//
// Contract these tests pin for the implementation (knowledge-snapshot.ts):
//   writeGuidelinesFolder(guidelines, out, opts?): Promise<unknown>
//     guidelines  the absolute folder of markdown files; out the knowledge folder to write (REQUIRED.md, INDEX.md);
//                 opts { ticketFolder?, cwd?, homedir? } as writeKnowledgeFolder takes (the guard of the out folder)
//     REQUIRED.md carries the provenance header (renderProvenance) and a section per file titled with the file name;
//                 each page of the header names its file and holds the sha256 of the file's text as markdownHash
//     INDEX.md    lists every file name it joined, and no other
//     refusal     throws an Error whose message names the guidelines folder
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseProvenance, verifyKnowledgeDir, verifySnapshot, writeGuidelinesFolder } from './knowledge-snapshot.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-guidelines-')))
  temps.push(dir)
  return dir
}

/** A client root with a guidelines folder holding `files`, and the ticket folder the knowledge folder goes under. */
async function client(files: Record<string, string>): Promise<{ guidelines: string; ticketFolder: string; out: string }> {
  const root = await scratch()
  const guidelines = join(root, 'rules')
  await mkdir(guidelines, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(guidelines, name), text)
  const ticketFolder = join(root, '.work', 'nom-4-x')
  await mkdir(ticketFolder, { recursive: true })
  return { guidelines, ticketFolder, out: join(ticketFolder, 'knowledge') }
}

const TEN = '**TEN-001 — MUST** ten first.\n'
const TWO = '**REV-001 — MUST** read AGENTS.md. two second.\n'
const A = '**A-001 — MUST** a third.\n'
const FILES = { '10-x.md': TEN, '2-x.md': TWO, 'a.md': A, 'notes.txt': 'not a guideline: notes-only-marker\n' }

describe('writeGuidelinesFolder', () => {
  it('T26 joins the .md files in code-unit order into REQUIRED.md and leaves notes.txt out', async () => {
    const { guidelines, ticketFolder, out } = await client(FILES)
    await writeGuidelinesFolder(guidelines, out, { ticketFolder })
    const required = await readFile(join(out, 'REQUIRED.md'), 'utf8')
    const at = ['TEN-001', 'REV-001', 'A-001'].map((marker) => required.indexOf(marker))
    expect([at.every((index) => index >= 0), at[0]! < at[1]! && at[1]! < at[2]!, required.includes('notes-only-marker')]).toEqual([true, true, false])
  })

  it('T26 writes the provenance header naming the folder with one hash per file, and an INDEX.md of the three files', async () => {
    const { guidelines, ticketFolder, out } = await client(FILES)
    await writeGuidelinesFolder(guidelines, out, { ticketFolder })
    const header = parseProvenance(await readFile(join(out, 'REQUIRED.md'), 'utf8'))
    expect(header).not.toBeNull()
    expect([header!.rootUrl.includes(guidelines), header!.rootId.includes(guidelines)]).toEqual([true, true])
    const joined = header!.pages.filter((page) => ['10-x.md', '2-x.md', 'a.md'].includes(page.file))
    expect(joined.map((page) => [page.file, page.markdownHash])).toEqual(
      expect.arrayContaining([
        ['10-x.md', sha256(TEN)],
        ['2-x.md', sha256(TWO)],
        ['a.md', sha256(A)],
      ]),
    )
    expect(header!.pages.some((page) => page.file === 'notes.txt')).toBe(false)
    const index = await readFile(join(out, 'INDEX.md'), 'utf8')
    expect(['10-x.md', '2-x.md', 'a.md'].every((name) => index.includes(name)) && !index.includes('notes.txt')).toBe(true)
  })

  it('T26 is accepted by both verifiers with the root id from its header, and refused after one byte of REQUIRED.md is edited', async () => {
    const { guidelines, ticketFolder, out } = await client(FILES)
    await writeGuidelinesFolder(guidelines, out, { ticketFolder })
    const file = join(out, 'REQUIRED.md')
    const text = await readFile(file, 'utf8')
    const expectedRootId = parseProvenance(text)!.rootId
    expect([(await verifySnapshot(file, { expectedRootId })).ok, (await verifyKnowledgeDir(out, { expectedRootId })).ok]).toEqual([true, true])
    await writeFile(file, text.replace('two second', 'two secone'))
    expect([(await verifySnapshot(file, { expectedRootId })).ok, (await verifyKnowledgeDir(out, { expectedRootId })).ok]).toEqual([false, false])
  })

  it('T26 refuses a snapshot for another root', async () => {
    const { guidelines, ticketFolder, out } = await client(FILES)
    await writeGuidelinesFolder(guidelines, out, { ticketFolder })
    expect((await verifyKnowledgeDir(out, { expectedRootId: 'https://www.notion.so/some-other-root' })).ok).toBe(false)
  })

  it('T27 refuses a missing folder, a folder with only notes.txt and a folder whose markdown has no REV-001, naming the folder', async () => {
    const missing = await client({})
    const missingFolder = join(missing.guidelines, 'not-there')
    const onlyNotes = await client({ 'notes.txt': 'notes\n' })
    const noRule = await client({ 'a.md': A, 'b.md': '**B-001 — MUST** b.\n' })
    for (const [folder, setup] of [[missingFolder, missing], [onlyNotes.guidelines, onlyNotes], [noRule.guidelines, noRule]] as const) {
      const message = await writeGuidelinesFolder(folder, setup.out, { ticketFolder: setup.ticketFolder }).then(
        () => 'no refusal',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect([folder, message.includes(folder)]).toEqual([folder, true])
    }
  })

  it('T27 writes nothing when it refuses', async () => {
    const { guidelines, ticketFolder, out } = await client({ 'a.md': A })
    await writeGuidelinesFolder(guidelines, out, { ticketFolder }).catch(() => undefined)
    const written = await readFile(join(out, 'REQUIRED.md'), 'utf8').catch(() => null)
    expect(written).toBeNull()
  })
})
