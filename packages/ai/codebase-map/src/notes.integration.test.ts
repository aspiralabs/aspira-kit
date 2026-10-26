// KIT-69 T18-T23 (F22-F26, F32): notes at seam S1. The notes step driver (kit map-codebase notes) prints
// one JSON step { stage, task, output } and, on its next run, ingests what the session wrote to
// `output` as candidate notes; accept and retire are human commands; hand-written note files are read
// like ingested ones; a rebuild downgrades accepted notes whose evidence moved; every ingested note is
// redacted. Fixture repos hold fake credential values in .env files (never real ones).

import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAIN, SLOW, build, briefCli, cleanup, fileHash, git, handNote, inRepo, makeRepo, noteIds, notesCli, notesDir, packetOf, proposeNotes, readNotes, snapshot } from './fixture.test-helper.ts'

afterAll(cleanup)

const read = (path: string): Promise<string> => readFile(path, 'utf8')

async function fresh(files = CHAIN, untracked: Record<string, string> = {}): Promise<{ repo: string; root: string }> {
  const repo = await makeRepo(files, { untracked })
  const root = inRepo(repo)
  expect((await build(repo)).code).toBe(0)
  return { repo, root }
}

describe('F22: the notes step driver proposes candidates', () => {
  it('T18: the first run prints a subagent task and an output file, the second writes a candidate note the brief does not show', async () => {
    const { repo, root } = await fresh()
    const run = await proposeNotes(repo, root, [{ title: 'Auth flow', text: 'Sessions are checked in src/a.ts only', paths: ['src/a.ts'] }])
    const notes = await readNotes(root)
    const [id, note] = Object.entries(notes)[0] ?? ['', undefined]
    const json = await briefCli(repo, root, ['src/a.ts'], ['--json'])
    const text = await briefCli(repo, root, ['src/a.ts'])
    expect({
      first: { code: run.first.code, stage: run.stage.stage, task: run.stage.task.length > 0, accept: /accept/i.test(run.stage.task), output: run.stage.output.length > 0, network: /openrouter|api[ _-]?key/i.test(run.first.out) },
      second: { code: run.second.code, count: Object.keys(notes).length, id: id.startsWith('auth-flow') && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id), status: note?.status, text: note?.text, cited: note?.evidence.map((entry) => [entry.path, entry.hash]) },
      hidden: [json.stdout, text.stdout].map((out) => out.includes('Sessions are checked')),
      printed: [id, 'Auth flow', 'Sessions are checked in src/a.ts only'].map((part) => part !== '' && run.second.stdout.includes(part)),
    }).toEqual({
      first: { code: 0, stage: 'step', task: true, accept: true, output: true, network: false },
      second: { code: 0, count: 1, id: true, status: 'candidate', text: 'Sessions are checked in src/a.ts only', cited: [['src/a.ts', await fileHash(repo, 'src/a.ts')]] },
      hidden: [false, false],
      printed: [true, true, true],
    })
  }, SLOW)
})

describe('F23: accept and retire', () => {
  it('T19: the lifecycle transitions, the no-ops, the refusal of retired and of invalid or unknown ids', async () => {
    const { repo, root } = await fresh()
    const old = '0'.repeat(64)
    for (const [id, status] of [['c1', 'candidate'], ['a1', 'accepted'], ['s1', 'stale'], ['r1', 'retired'], ['c2', 'candidate'], ['a2', 'accepted'], ['s2', 'stale'], ['r2', 'retired']] as const) {
      await handNote(repo, root, { id, status, text: `note ${id}`, paths: ['src/a.ts'], hash: status === 'stale' ? old : undefined })
    }
    const seeded = await snapshot(notesDir(root))

    const bad: Record<string, number> = {}
    for (const id of ['../x', 'Bad_ID', 'nope-1']) for (const verb of ['accept', 'retire']) bad[`${verb} ${id}`] = (await notesCli(repo, root, verb, id)).code
    const afterBad = await snapshot(notesDir(root))

    const accept: Record<string, number> = {}
    const retire: Record<string, number> = {}
    for (const id of ['c1', 'a1', 's1', 'r1']) accept[id] = (await notesCli(repo, root, 'accept', id)).code
    for (const id of ['c2', 'a2', 's2', 'r2']) retire[id] = (await notesCli(repo, root, 'retire', id)).code
    const after = await readNotes(root)
    const now = await snapshot(notesDir(root))
    const current = await fileHash(repo, 'src/a.ts')

    expect({
      bad: Object.values(bad).every((code) => code !== 0),
      badUnchanged: JSON.stringify(afterBad) === JSON.stringify(seeded),
      accept: { c1: accept.c1, a1: accept.a1, s1: accept.s1, r1: accept.r1 !== 0 },
      retire: { c2: retire.c2, a2: retire.a2, s2: retire.s2, r2: retire.r2 },
      status: Object.fromEntries(Object.entries(after).map(([id, note]) => [id, note.status])),
      staleRehashed: after.s1?.evidence.map((entry) => entry.hash),
      noOps: [now['a1.json'] === seeded['a1.json'], now['r1.json'] === seeded['r1.json'], now['r2.json'] === seeded['r2.json']],
    }).toEqual({
      bad: true,
      badUnchanged: true,
      accept: { c1: 0, a1: 0, s1: 0, r1: true },
      retire: { c2: 0, a2: 0, s2: 0, r2: 0 },
      status: { c1: 'accepted', a1: 'accepted', s1: 'accepted', r1: 'retired', c2: 'retired', a2: 'retired', s2: 'retired', r2: 'retired' },
      staleRehashed: [current],
      noOps: [true, true, true],
    })
  }, SLOW)
})

describe('F24: hand-written notes', () => {
  it('T20: a hand-written accepted note briefs like an ingested one; one citing a path outside the repo, one whose id is not its file name and one with an invalid status are ignored', async () => {
    const repo = await makeRepo(CHAIN)
    const root = inRepo(repo)
    await handNote(repo, root, { id: 'hand-1', text: 'Written by a person about a.ts', paths: ['src/a.ts'] })
    await handNote(repo, root, { id: 'bad-1', text: 'Cites a file outside the repo', paths: ['../outside.ts'] })
    // each of these cites src/a.ts too, so only the shared note reader keeps them out of the brief
    await handNote(repo, root, { id: 'bad-2', text: 'Cites a.ts and a file outside the repo', paths: ['src/a.ts', '../outside.ts'] })
    await rename(await handNote(repo, root, { id: 'y-1', text: 'Stored under another name', paths: ['src/a.ts'] }), join(notesDir(root), 'x-1.json'))
    await handNote(repo, root, { id: 'bad-3', status: 'Accepted', text: 'Status not in the lifecycle', paths: ['src/a.ts'] })
    const built = await build(repo)
    const proposed = await proposeNotes(repo, root, [{ title: 'Ingested', text: 'Written by a subagent about a.ts', paths: ['src/a.ts'] }])
    const ingested = (await noteIds(root)).find((id) => id.startsWith('ingested'))!
    expect((await notesCli(repo, root, 'accept', ingested)).code).toBe(0)
    const run = await briefCli(repo, root, ['src/a.ts'], ['--json'])
    const packet = await packetOf(repo, root, ['src/a.ts'])
    const byId = Object.fromEntries(packet.notes.map((note) => [note.id, note]))
    expect({
      built: built.code,
      proposed: proposed.second.code,
      ids: Object.keys(byId).sort(),
      text: byId['hand-1']?.text,
      sameShape: Object.keys(byId['hand-1'] ?? {}).sort().join() === Object.keys(byId[ingested] ?? {}).sort().join(),
      warned: [built.out, run.stderr].some((out) => out.includes('bad-1') && /ignor|invalid|outside/i.test(out)),
    }).toEqual({ built: 0, proposed: 0, ids: ['hand-1', ingested].sort(), text: 'Written by a person about a.ts', sameShape: true, warned: true })
  }, SLOW)
})

describe('F25: accepted notes go stale when their evidence moves', () => {
  it('T21: an edited, deleted or renamed cited file makes accepted notes stale; candidate and retired notes stay; briefs list stale notes by id and path only', async () => {
    const files = { ...CHAIN, 'src/edit.ts': 'export const e = 1\n', 'src/del.ts': 'export const d = 1\n', 'src/ren.ts': 'export const r = 1\n', 'src/keep.ts': 'export const k = 1\n' }
    const { repo, root } = await fresh(files)
    await handNote(repo, root, { id: 'n-edit', text: 'TEXT-edit', paths: ['src/edit.ts'] })
    await handNote(repo, root, { id: 'n-del', text: 'TEXT-del', paths: ['src/del.ts', 'src/keep.ts'] })
    await handNote(repo, root, { id: 'n-ren', text: 'TEXT-ren', paths: ['src/ren.ts', 'src/keep.ts'] })
    await handNote(repo, root, { id: 'cand-edit', status: 'candidate', text: 'TEXT-cand', paths: ['src/edit.ts'] })
    await handNote(repo, root, { id: 'ret-del', status: 'retired', text: 'TEXT-ret', paths: ['src/del.ts', 'src/keep.ts'] })
    const untouched = await snapshot(notesDir(root))

    await writeFile(join(repo, 'src/edit.ts'), 'export const e = 2\n')
    await unlink(join(repo, 'src/del.ts'))
    await git(repo, 'mv', 'src/ren.ts', 'src/ren2.ts')
    expect((await build(repo)).code).toBe(0)

    const notes = await readNotes(root)
    const now = await snapshot(notesDir(root))
    const [edit, keep] = await Promise.all([briefCli(repo, root, ['src/edit.ts'], ['--json']), briefCli(repo, root, ['src/keep.ts'], ['--json'])])
    const stale = (out: string): string[] => (JSON.parse(out) as { stale: { id: string; path: string }[] }).stale.map((entry) => entry.id).sort()
    expect({
      status: Object.fromEntries(Object.entries(notes).map(([id, note]) => [id, note.status])),
      unchanged: [now['cand-edit.json'] === untouched['cand-edit.json'], now['ret-del.json'] === untouched['ret-del.json']],
      stale: { edit: stale(edit.stdout), keep: stale(keep.stdout) },
      paths: [...(JSON.parse(edit.stdout) as { stale: { path: string }[] }).stale, ...(JSON.parse(keep.stdout) as { stale: { path: string }[] }).stale].every((entry) => typeof entry.path === 'string' && entry.path.startsWith('src/')),
      noText: [edit.stdout, keep.stdout].map((out) => out.includes('TEXT-')),
    }).toEqual({
      status: { 'n-edit': 'stale', 'n-del': 'stale', 'n-ren': 'stale', 'cand-edit': 'candidate', 'ret-del': 'retired' },
      unchanged: [true, true],
      stale: { edit: ['n-edit'], keep: ['n-del', 'n-ren'] },
      paths: true,
      noText: [false, false],
    })
  }, SLOW)
})

describe('F26: notes are redacted', () => {
  it('T22: ingested note text has every .env value (root, aspira app, cited package) and token replaced; a hand-written note prints redacted inside the unverified block', async () => {
    const rootValue = 'rootcred-4f8a1c'
    const appValue = 'webcred-9b2d7e'
    const pkgValue = 'pkgcred-3c6e0a'
    const token = 'ghp_abcdefghijklmnop1234567890'
    const files = { ...CHAIN, 'apps/web/src/w.ts': 'export const w = 1\n', 'packages/pkg/package.json': JSON.stringify({ name: '@fx/pkg' }), 'packages/pkg/src/x.ts': 'export const x = 1\n' }
    const { repo, root } = await fresh(files, {
      'aspira.json': JSON.stringify({ app: 'apps/web' }),
      '.env': `ROOT_API_KEY=${rootValue}\n`,
      'apps/web/.env': `WEB_SECRET=${appValue}\n`,
      'packages/pkg/.env': `PKG_TOKEN=${pkgValue}\n`,
    })
    const text = `Config uses ${rootValue}, ${appValue}, ${pkgValue} and ${token} together`
    const run = await proposeNotes(repo, root, [{ title: 'Credentials', text, paths: ['packages/pkg/src/x.ts', 'src/a.ts'] }])
    const written = await read(join(notesDir(root), `${(await noteIds(root))[0]}.json`))
    await handNote(repo, root, { id: 'hand-secret', text: `Hand-written, mentions ${rootValue}`, paths: ['src/a.ts'] })
    const brief = await briefCli(repo, root, ['src/a.ts'])
    expect({
      ran: run.second.code,
      leaked: [rootValue, appValue, pkgValue, token].filter((value) => written.includes(value)),
      marked: written.includes('[redacted]'),
      printed: { leaked: [rootValue, appValue, pkgValue, token].filter((value) => run.second.out.includes(value)), marked: run.second.stdout.includes('[redacted]') },
      brief: { code: brief.code, leaked: brief.stdout.includes(rootValue), inBlock: /unverified[\s\S]*\[redacted\]/i.test(brief.stdout) },
    }).toEqual({ ran: 0, leaked: [], marked: true, printed: { leaked: [], marked: true }, brief: { code: 0, leaked: false, inBlock: true } })
  }, SLOW)
})

describe('F32: simultaneous note writes', () => {
  it('T23: two accepts of one note leave one valid file with status accepted', async () => {
    const { repo, root } = await fresh()
    await handNote(repo, root, { id: 'c1', status: 'candidate', text: 'note c1', paths: ['src/a.ts'] })
    const runs = await Promise.all([notesCli(repo, root, 'accept', 'c1'), notesCli(repo, root, 'accept', 'c1')])
    const note = JSON.parse(await read(join(notesDir(root), 'c1.json'))) as { status: string }
    expect({ codes: runs.map((run) => run.code), status: note.status, files: await readdir(notesDir(root)) }).toEqual({ codes: [0, 0], status: 'accepted', files: ['c1.json'] })
  }, SLOW)
})
