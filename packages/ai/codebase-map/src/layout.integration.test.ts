// KIT-69 T10-T11 (F3, F4): where the map and its notes live, at seam S1 with real git. The in-repo
// layout keeps notes committable and the map out of git status; the harness layout (a --map-root
// outside the repo, which `kit map-codebase` derives from aspira.json's codebaseMaps) writes nothing
// into the repo, gives a linked worktree its own map under worktrees/<name>/map while it reads the
// main checkout's notes, and refuses a second repo of the same name under one key folder.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAIN, SLOW, build, cleanup, git, handNote, inRepo, makeRepo, mapDir, noteIds, notesCli, packetOf, proposeNotes, readNotes, snapshot, tempDir } from './fixture.test-helper.ts'

afterAll(cleanup)

describe('F3: the in-repo notes folder is committed and the map is not', () => {
  it('T10: a note written on each branch shows as .codebase-map/notes/<id>.json in git status, map/ does not, and the merge has no conflict', async () => {
    const repo = await makeRepo(CHAIN)
    // the global ignore holds .codebase-map/map/ (kit update); the repo's own exclude stands in for it so
    // the tests of one file, which share a HOME, never write each other's global ignore
    await writeFile(join(repo, '.git', 'info', 'exclude'), '.codebase-map/map/\n')
    const root = inRepo(repo)
    const status = async (): Promise<string[]> => (await git(repo, 'status', '--porcelain', '-uall')).split('\n').filter((line) => line !== '').map((line) => line.slice(3))
    const note = async (title: string, branch: string): Promise<{ id: string; status: string[] }> => {
      await git(repo, 'checkout', '-q', '-b', branch, 'main')
      expect((await build(repo)).code).toBe(0)
      const before = await noteIds(root)
      const run = await proposeNotes(repo, root, [{ title, text: `${title} lives in src/a.ts`, paths: ['src/a.ts'] }])
      expect(run.second.code).toBe(0)
      const id = (await noteIds(root)).find((candidate) => !before.includes(candidate))!
      const shown = await status()
      await git(repo, 'add', '.codebase-map/notes')
      await git(repo, 'commit', '-q', '-m', `note ${title}`)
      return { id, status: shown }
    }
    const a = await note('Alpha flow', 'a')
    const b = await note('Beta flow', 'b')
    await git(repo, 'checkout', '-q', 'a')
    const merge = await git(repo, 'merge', '--no-edit', 'b').then(() => 'merged', (error: Error) => error.message)
    expect({
      ids: a.id !== b.id,
      statusA: a.status,
      statusB: b.status,
      merge,
      notes: (await noteIds(root)).sort(),
    }).toEqual({
      ids: true,
      statusA: [`.codebase-map/notes/${a.id}.json`],
      statusB: [`.codebase-map/notes/${b.id}.json`],
      merge: 'merged',
      notes: [a.id, b.id].sort(),
    })
  }, SLOW)

  it('T10b: a pending proposals file of the notes step, not yet redacted, is covered by the global ignore entries', async () => {
    const repo = await makeRepo(CHAIN)
    // the two .codebase-map lines of the global ignore kit update writes (IGNORE_ENTRIES, pinned in src/cli.test.ts T9),
    // standing in as the repo's own exclude; codebase-map/ never imports the kit's src
    await writeFile(join(repo, '.git', 'info', 'exclude'), '.codebase-map/map/\n.codebase-map/notes-step/\n')
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    const step = JSON.parse((await notesCli(repo, root)).stdout.trim()) as { output: string }
    await mkdir(dirname(step.output), { recursive: true })
    await writeFile(step.output, '{ "notes": [ unfinished')
    const failed = await notesCli(repo, root)
    expect({ failed: failed.code, status: await git(repo, 'status', '--porcelain', '-uall') }).toEqual({ failed: 1, status: '' })
  }, SLOW)
})

describe('F4: the harness layout keeps the repo untouched', () => {
  it('T11: main map and notes under <key>/loantrack-web, the worktree’s map under worktrees/<name>/map reading the main notes, a same-named repo refused', async () => {
    const key = await tempDir('cmap-key-')
    const files = { ...CHAIN, '.gitignore': '.worktrees/\n' }
    const main = await makeRepo(files, { name: 'loantrack-web' })
    const other = await makeRepo(CHAIN, { name: 'loantrack-web' })
    const harness = join(key, 'loantrack-web')
    const worktree = join(main, '.worktrees', 'FEATURE-X-1')
    await git(main, 'worktree', 'add', '-q', '-b', 'feat/x', worktree)
    const status = (dir: string): Promise<string> => git(dir, 'status', '--porcelain', '-uall')

    const statusBefore = await status(main)
    const first = await build(main, harness)
    await handNote(main, harness, { id: 'main-note-1', text: 'the main checkout’s note', paths: ['src/a.ts'] })
    const mainMap = await snapshot(mapDir(harness))
    const statusAfter = await status(main)

    const second = await build(worktree, harness)
    const inWorktree = await packetOf(worktree, harness, ['src/a.ts'])
    const mainMapAfter = await snapshot(mapDir(harness))
    const everything = await snapshot(harness)

    const third = await build(other, harness)
    const afterRefusal = await snapshot(harness)

    expect({
      first: { code: first.code, map: Object.keys(mainMap).includes('manifest.json'), status: statusAfter === statusBefore, noFolder: Object.keys(await snapshot(join(main, '.codebase-map'))) },
      second: { code: second.code, map: Object.keys(await snapshot(join(harness, 'worktrees', 'FEATURE-X-1', 'map'))).includes('manifest.json'), mainSame: JSON.stringify(mainMapAfter) === JSON.stringify(mainMap), notes: inWorktree.notes.map((note) => note.id), worktreeStatus: await status(worktree) },
      third: { refused: third.code !== 0, names: [main, other].every((path) => third.out.includes(path)), same: JSON.stringify(afterRefusal) === JSON.stringify(everything), noFolder: Object.keys(await snapshot(join(other, '.codebase-map'))) },
    }).toEqual({
      first: { code: 0, map: true, status: true, noFolder: [] },
      second: { code: 0, map: true, mainSame: true, notes: ['main-note-1'], worktreeStatus: '' },
      third: { refused: true, names: true, same: true, noFolder: [] },
    })
  }, SLOW)

  it('T11b: a build of a linked worktree that edited a cited file leaves the main checkout’s shared notes accepted', async () => {
    const key = await tempDir('cmap-key-')
    const main = await makeRepo({ ...CHAIN, '.gitignore': '.worktrees/\n' }, { name: 'loantrack-web' })
    const harness = join(key, 'loantrack-web')
    const worktree = join(main, '.worktrees', 'FEATURE-X-2')
    await git(main, 'worktree', 'add', '-q', '-b', 'feat/x2', worktree)
    expect((await build(main, harness)).code).toBe(0)
    await handNote(main, harness, { id: 'main-note-1', text: 'the main checkout’s note', paths: ['src/a.ts'] })
    await writeFile(join(worktree, 'src/a.ts'), 'export const changedInTheWorktree = 1\n')
    const built = await build(worktree, harness)
    const notes = await readNotes(harness)
    const inMain = await packetOf(main, harness, ['src/a.ts'])
    expect({ built: built.code, status: notes['main-note-1']?.status, mainNotes: inMain.notes.map((note) => note.id) }).toEqual({ built: 0, status: 'accepted', mainNotes: ['main-note-1'] })
  }, SLOW)
})
