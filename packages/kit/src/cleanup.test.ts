// `kit cleanup` against real git: every case builds a bare origin and a main checkout pushed to it in
// a temporary directory, adds ticket worktrees with `git worktree add`, and runs cleanup() at its
// seam. Only the two system boundaries are faked: the board (an injected TicketLookup answering from
// a per-test map, or the live lookup over a fake agent-common resolve script in T39) and the terminal
// (an injected confirmation reader, or none for no terminal). Assertions read the logged lines, the
// exit code and the filesystem and git state.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from './cleanup.js'
import { lookupTicket, type TicketLookup, type TicketLookupResult } from './ticket-lookup.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'

type Ask = (prompt: string) => Promise<string | null>
type Repo = { tmp: string; origin: string; root: string; project: string }
type Cards = Record<string, TicketLookupResult>

const startCwd = process.cwd()
const temporary: string[] = []
const readOnly: string[] = []

afterEach(() => {
  process.chdir(startCwd)
  for (const dir of readOnly.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o755)
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** git with a fixed identity and no signing, so the user's global config cannot change a fixture. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=Kit Test', '-c', 'user.email=kit@test.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${run.stderr}`)
  return run.stdout.trim()
}

const hasBranch = (repo: string, branch: string): boolean => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0

/**
 * A bare origin and a main checkout pushed to it. The checkout's .gitignore lists .work/, .worktrees/,
 * .env.local and node_modules/; aspira.json (with the board, unless `board` is false) sits at the
 * project root, which is the checkout's root or `<root>/<project>`. The process stands in the
 * temporary directory (not a git repository), so nothing here can reach the kit's own checkout.
 */
function repository(opts: { project?: string; board?: boolean } = {}): Repo {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kit-cleanup-')))
  temporary.push(tmp)
  const origin = join(tmp, 'origin.git')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  const root = join(tmp, 'main')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  const project = opts.project === undefined ? root : join(root, opts.project)
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'aspira.json'), JSON.stringify(opts.board === false ? {} : { board: BOARD }))
  writeFileSync(join(root, '.gitignore'), '.work/\n.worktrees/\n.env.local\nnode_modules/\n')
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-q', '-u', 'origin', 'main')
  process.chdir(tmp)
  return { tmp, origin, root, project }
}

/**
 * A worktree on a new branch with one commit of its own. `merged`: pushed, merged into main with a
 * merge commit and main pushed; `merged-deleted`: the same, then the branch deleted on origin;
 * `squashed`: pushed, squash-merged into main as a new commit, main pushed, branch deleted on origin;
 * `pushed`: pushed (no upstream set) but not merged; `unpushed`: never pushed.
 */
function worktree(repo: Repo, handle: string, branch: string, state: 'merged' | 'merged-deleted' | 'squashed' | 'pushed' | 'unpushed' = 'merged', at?: string): string {
  const path = at ?? join(repo.root, '.worktrees', handle)
  mkdirSync(dirname(path), { recursive: true })
  git(repo.root, 'worktree', 'add', '-q', '-b', branch, path, 'main')
  writeFileSync(join(path, `${branch.replace(/\//g, '-')}.txt`), `work on ${handle}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', `work on ${handle}`)
  if (state === 'unpushed') return path
  git(path, 'push', '-q', 'origin', branch)
  if (state === 'pushed') return path
  if (state === 'squashed') {
    git(repo.root, 'merge', '-q', '--squash', branch)
    git(repo.root, 'commit', '-q', '-m', `${branch} (squashed)`)
  } else {
    git(repo.root, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch)
  }
  git(repo.root, 'push', '-q', 'origin', 'main')
  if (state !== 'merged') git(repo.root, 'push', '-q', 'origin', '--delete', branch)
  return path
}

/** `<checkout>/.work/<name>` with a ticket.md as the agents write it, an unreadable one, or none. */
function workFolder(checkout: string, name: string, ticket: { id: string; status?: string } | 'none' | 'unreadable'): string {
  const folder = join(checkout, '.work', name)
  mkdirSync(folder, { recursive: true })
  if (ticket === 'unreadable') {
    writeFileSync(join(folder, 'ticket.md'), '| Field | Value |\n| --- | --- |\n| ID | KIT-6 |\n')
  } else if (ticket !== 'none') {
    writeFileSync(join(folder, 'ticket.md'), `# ${ticket.id}: Ticket ${ticket.id}\n\n| Field | Value |\n| --- | --- |\n| ID | ${ticket.id} |\n| Status | ${ticket.status ?? 'In Progress: Plan'} |\n`)
  }
  return folder
}

/** A card on the board; `type` null stands for an agent-common that prints no `type=` line. */
function card(id: string, status: string, type: string | null = 'Feature'): TicketLookupResult {
  const base = { id, title: `Ticket ${id}`, url: `https://www.notion.so/${id.toLowerCase()}`, status, folder: `${id.toLowerCase()}-x` }
  return { ticket: type === null ? base : { ...base, type } }
}

/** The board boundary: answers from the map (keys upper case), unknown ID for anything else. */
function board(cards: Cards): TicketLookup {
  return (url, ref) => {
    if (url !== BOARD) throw new Error(`looked up on an unexpected board: ${url}`)
    return cards[ref.toUpperCase()] ?? { reason: 'unknown ID', detail: `No ticket ${ref} on the board`, cause: 'board' }
  }
}

async function run(projectRoot: string, cards: Cards | TicketLookup, opts: { yes?: boolean; only?: string[]; ask?: Ask } = {}): Promise<{ code: number; lines: string[]; warnings: string[] }> {
  const lines: string[] = []
  const warnings: string[] = []
  const code = await cleanup({
    projectRoot,
    yes: opts.yes ?? false,
    ...(opts.only === undefined ? {} : { only: opts.only }),
    lookup: typeof cards === 'function' ? cards : board(cards),
    ...(opts.ask === undefined ? {} : { ask: opts.ask }),
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line.trimEnd()),
  })
  return { code, lines, warnings }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The output lines naming exactly this path (not a path below it or a longer sibling). */
const about = (lines: string[], path: string): string[] => lines.filter((line) => new RegExp(`${escape(path)}(?![\\w/-])`).test(line))
/** The listing line for a path: the first line naming it. */
const listed = (lines: string[], path: string): string => about(lines, path)[0] ?? ''
const firstIndex = (lines: string[], path: string): number => lines.findIndex((line) => about([line], path).length > 0)
const lastIndex = (lines: string[], path: string): number => lines.findLastIndex((line) => about([line], path).length > 0)

const throwingReader: Ask = async () => {
  throw new Error('the reader was asked')
}

describe('kit cleanup listing', () => {
  it('T19: marks a working folder delete or keep by the live Status, not the Status in its ticket.md', async () => {
    const repo = repository()
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1', status: 'In Progress: Plan' })
    const open = workFolder(repo.root, 'kit-2-open', { id: 'KIT-2', status: 'In Progress: Plan' })
    const { lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released'), 'KIT-2': card('KIT-2', 'Ready: Spec') })
    const doneLine = listed(lines, done)
    const openLine = listed(lines, open)
    expect({
      done: ['KIT-1', 'Released'].every((part) => doneLine.includes(part)) && /\bdelete\b/.test(doneLine),
      open: ['KIT-2', 'Ready: Spec'].every((part) => openLine.includes(part)) && /\bkeep\b/.test(openLine),
    }).toEqual({ done: true, open: true })
  })

  it('T19: lists a ticket worktree\'s working folder at the project\'s path below the git root', async () => {
    const repo = repository({ project: 'product' })
    const wt = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const folder = workFolder(join(wt, 'product'), 'kit-3-x', { id: 'KIT-3' })
    const { lines } = await run(repo.project, { 'KIT-3': card('KIT-3', 'In Progress: Spec') })
    const line = listed(lines, folder)
    expect(folder).toBe(join(repo.root, '.worktrees', 'FEATURE-KIT-3', 'product', '.work', 'kit-3-x'))
    expect(line.includes('KIT-3') && /\bkeep\b/.test(line)).toBe(true)
  })

  it('T20: lists only ticket worktrees under .worktrees/<TYPE>-<ID> and never touches the others', async () => {
    const repo = repository()
    const feature = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const bug = worktree(repo, 'BUG-KIT-4', 'fix/kit-4-x')
    const stray = worktree(repo, 'stray', 'feat/stray')
    const lower = worktree(repo, 'feature-KIT-5', 'feat/kit-5-x')
    const elsewhere = worktree(repo, 'FEATURE-KIT-6', 'feat/kit-6-x', 'merged', join(repo.tmp, 'elsewhere', 'FEATURE-KIT-6'))
    const head = git(repo.root, 'rev-parse', 'HEAD')
    const cards = {
      'KIT-3': card('KIT-3', 'Released', 'Feature'),
      'KIT-4': card('KIT-4', 'In Progress: Implementation', 'Bug'),
      'KIT-5': card('KIT-5', 'Released'),
      'KIT-6': card('KIT-6', 'Released'),
    }
    const { lines } = await run(repo.root, cards, { yes: true })
    const featureLine = listed(lines, feature)
    const bugLine = listed(lines, bug)
    expect({
      feature: featureLine.includes('Released') && /\bdelete\b/.test(featureLine),
      bug: bugLine.includes('In Progress: Implementation') && /\bkeep\b/.test(bugLine),
      unlisted: [stray, lower, elsewhere].filter((path) => lines.some((line) => line.includes(path))),
      kept: [bug, stray, lower, elsewhere].filter((path) => !existsSync(path)),
      branches: ['fix/kit-4-x', 'feat/stray', 'feat/kit-5-x', 'feat/kit-6-x'].filter((branch) => !hasBranch(repo.root, branch)),
      main: { head: git(repo.root, 'rev-parse', 'HEAD'), status: git(repo.root, 'status', '--porcelain'), exists: existsSync(join(repo.root, 'README.md')) },
    }).toEqual({ feature: true, bug: true, unlisted: [], kept: [], branches: [], main: { head, status: '', exists: true } })
  })
})

describe('kit cleanup confirmation', () => {
  it.each([
    ['n', false],
    ['', false],
    [null, false],
    ['YES', true],
  ])('T21: asks "Delete 1 folders and remove 0 worktrees? [y/N]" and deletes only on y or yes (answer %j)', async (answer, deletes) => {
    const repo = repository()
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const prompts: string[] = []
    const ask: Ask = async (prompt) => {
      prompts.push(prompt.trim())
      return answer
    }
    const { code, lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released') }, { ask })
    expect({
      prompts,
      exists: existsSync(done),
      saysNothingDeleted: lines.some((line) => /nothing was deleted/i.test(line)),
      code,
    }).toEqual({ prompts: ['Delete 1 folders and remove 0 worktrees? [y/N]'], exists: !deletes, saysNothingDeleted: !deletes, code: 0 })
  })

  it('T22: with no terminal and no --yes, deletes nothing and says to rerun with --yes', async () => {
    const repo = repository()
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const { code, lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released') })
    expect({ exists: existsSync(done), saysRerun: lines.some((line) => /re-?run\b.*--yes/i.test(line)), code }).toEqual({ exists: true, saysRerun: true, code: 0 })
  })

  it('T23: --yes deletes the marked folder and worktree outright without asking, leaving no copy behind', async () => {
    const repo = repository()
    const marker = `kit-cleanup-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    writeFileSync(join(done, 'notes.md'), `${marker}\n`)
    const wt = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const { code } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released'), 'KIT-3': card('KIT-3', 'Released') }, { yes: true, ask: throwingReader })
    const holding = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        const stat = lstatSync(path)
        if (stat.isDirectory()) return holding(path)
        return stat.isFile() && readFileSync(path).includes(marker) ? [path] : []
      })
    expect({ folder: existsSync(done), worktree: existsSync(wt), code, copies: holding(repo.tmp) }).toEqual({ folder: false, worktree: false, code: 0, copies: [] })
  })
})

describe('kit cleanup skips what it cannot judge', () => {
  it('T24: reports each unjudgeable folder with its reason, leaves it in place, and prints an unreachable board\'s cause once', async () => {
    const repo = repository()
    const outside = join(repo.tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    const link = join(repo.root, '.work', 'link')
    const folders: [string, string][] = [
      [workFolder(repo.root, 'kit-5-a', 'none'), 'no ticket.md'],
      [workFolder(repo.root, 'kit-6-b', 'unreadable'), 'ticket.md unreadable'],
      [workFolder(repo.root, 'kit-9-x', { id: 'KIT-8' }), 'folder name does not match ticket.md ID KIT-8'],
      [link, 'symlink'],
      [workFolder(repo.root, 'kit-10-c', { id: 'KIT-10' }), 'unknown ID'],
      [workFolder(repo.root, 'kit-11-d', { id: 'KIT-11' }), 'no Status on the card'],
      [workFolder(repo.root, 'kit-12-e', { id: 'KIT-12' }), 'board unreachable'],
      [workFolder(repo.root, 'kit-13-f', { id: 'KIT-13' }), 'board unreachable'],
    ]
    symlinkSync(outside, link)
    const unreachable: TicketLookupResult = { reason: 'board unreachable', detail: 'fetch failed', cause: 'board' }
    const cards: Cards = {
      'KIT-8': card('KIT-8', 'Released'),
      'KIT-11': { reason: 'no Status on the card', detail: 'KIT-11 has no Status', cause: 'board' },
      'KIT-12': unreachable,
      'KIT-13': unreachable,
    }
    const { lines, warnings } = await run(repo.root, cards, { yes: true })
    const fetchWarnings = warnings.filter((line) => line.includes('fetch failed'))
    expect({
      missing: folders.filter(([path]) => !existsSync(path)),
      outside: existsSync(join(outside, 'keep.txt')),
      unexplained: folders.filter(([path, reason]) => !listed(lines, path).includes(reason)),
      fetchWarnings: fetchWarnings.length,
      prefixed: fetchWarnings.every((line) => line.startsWith('kit cleanup:')),
    }).toEqual({
      missing: [],
      outside: true,
      unexplained: [],
      fetchWarnings: 1,
      prefixed: true,
    })
  })

  it('T25: after a kit-side lookup failure, prints its cause once and skips every folder as board unreachable', async () => {
    const repo = repository()
    const folders = [workFolder(repo.root, 'kit-1-a', { id: 'KIT-1' }), workFolder(repo.root, 'kit-2-b', { id: 'KIT-2' }), workFolder(repo.root, 'kit-3-c', { id: 'KIT-3' })]
    const lookup: TicketLookup = () => ({ reason: 'board unreachable', detail: 'agent-common not found', cause: 'kit' })
    const { lines, warnings } = await run(repo.root, lookup, { yes: true })
    const causes = warnings.filter((line) => line.includes('agent-common not found'))
    expect({
      causes: causes.length,
      prefixed: causes.every((line) => line.startsWith('kit cleanup:')),
      skipped: folders.filter((path) => !listed(lines, path).includes('skip (board unreachable)')),
      missing: folders.filter((path) => !existsSync(path)),
    }).toEqual({ causes: 1, prefixed: true, skipped: [], missing: [] })
  })
})

describe('kit cleanup never loses work', () => {
  it('T26: keeps a worktree with uncommitted tracked or untracked changes, but ignored files do not count', async () => {
    const repo = repository()
    const modified = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const untracked = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const ignoredOnly = worktree(repo, 'FEATURE-KIT-5', 'feat/kit-5-x')
    writeFileSync(join(modified, 'README.md'), '# changed\n')
    writeFileSync(join(untracked, 'new.txt'), 'new\n')
    workFolder(ignoredOnly, 'kit-9-q', { id: 'KIT-9' })
    mkdirSync(join(ignoredOnly, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(ignoredOnly, 'node_modules', 'pkg', 'index.js'), 'export {}\n')
    const cards = { 'KIT-3': card('KIT-3', 'Released'), 'KIT-4': card('KIT-4', 'Released'), 'KIT-5': card('KIT-5', 'Released'), 'KIT-9': card('KIT-9', 'In Progress: Spec') }
    const { lines } = await run(repo.root, cards, { yes: true })
    expect({
      modified: [listed(lines, modified).includes('uncommitted changes'), existsSync(modified)],
      untracked: [listed(lines, untracked).includes('uncommitted changes'), existsSync(untracked)],
      ignoredOnly: existsSync(ignoredOnly),
    }).toEqual({ modified: [true, true], untracked: [true, true], ignoredOnly: false })
  })

  it('T27: deletes a Released folder inside a kept worktree, and reports a folder inside a removed worktree deleted once', async () => {
    const repo = repository()
    const dirty = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    writeFileSync(join(dirty, 'README.md'), '# changed\n')
    const inDirty = workFolder(dirty, 'kit-7-x', { id: 'KIT-7' })
    const clean = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const inClean = workFolder(clean, 'kit-4-y', { id: 'KIT-4' })
    const cards = { 'KIT-3': card('KIT-3', 'Released'), 'KIT-4': card('KIT-4', 'Released'), 'KIT-7': card('KIT-7', 'Released') }
    const { code, lines } = await run(repo.root, cards, { yes: true })
    const inCleanLines = about(lines, inClean)
    expect({
      dirtyKept: existsSync(dirty),
      inDirtyGone: !existsSync(inDirty),
      cleanGone: !existsSync(clean),
      deletedOnce: inCleanLines.filter((line) => /\bdeleted\b/.test(line)).length,
      failedOrGone: inCleanLines.filter((line) => /failed|already gone/.test(line)),
      code,
    }).toEqual({ dirtyKept: true, inDirtyGone: true, cleanGone: true, deletedOnce: 1, failedOrGone: [], code: 0 })
  })

  it('T28: keeps unpushed and squash-merged worktrees (naming the branch) and removes one merged with its remote branch deleted', async () => {
    const repo = repository()
    const unpushed = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x', 'unpushed')
    const merged = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x', 'merged-deleted')
    const squashed = worktree(repo, 'FEATURE-KIT-5', 'feat/kit-5-x', 'squashed')
    const cards = { 'KIT-3': card('KIT-3', 'Released'), 'KIT-4': card('KIT-4', 'Released'), 'KIT-5': card('KIT-5', 'Released') }
    const { lines } = await run(repo.root, cards, { yes: true })
    const squashedLine = listed(lines, squashed)
    expect({
      unpushed: [listed(lines, unpushed).includes('unpushed commits'), existsSync(unpushed)],
      merged: [existsSync(merged), hasBranch(repo.root, 'feat/kit-4-x')],
      squashed: [squashedLine.includes('unpushed commits'), squashedLine.includes('feat/kit-5-x'), existsSync(squashed)],
    }).toEqual({ unpushed: [true, true], merged: [false, false], squashed: [true, true, true] })
  })

  it('T29: when git fetch fails, keeps Released worktrees as fetch failed and still cleans working folders', async () => {
    const repo = repository()
    const wt = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    git(repo.root, 'remote', 'set-url', 'origin', join(repo.tmp, 'missing.git'))
    const { lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released'), 'KIT-3': card('KIT-3', 'Released') }, { yes: true })
    expect({ fetchFailed: listed(lines, wt).includes('fetch failed'), worktree: existsSync(wt), folder: existsSync(done) }).toEqual({ fetchFailed: true, worktree: true, folder: false })
  })

  it('T30: removes the worktree but keeps a branch git branch -d refuses, and never touches the remote branch', async () => {
    const repo = repository()
    const wt = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x', 'pushed')
    const { lines } = await run(repo.root, { 'KIT-3': card('KIT-3', 'Released') }, { yes: true })
    expect({
      removed: !existsSync(wt),
      reportedKept: lines.some((line) => line.includes('feat/kit-3-x') && /\bkept\b/.test(line)),
      local: hasBranch(repo.root, 'feat/kit-3-x'),
      remote: hasBranch(repo.origin, 'feat/kit-3-x'),
    }).toEqual({ removed: true, reportedKept: true, local: true, remote: true })
  })

  it('T31: reports a folder or worktree that cannot be removed as failed with the reason, removes the rest, and exits 1', async () => {
    const repo = repository()
    const locked = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    git(repo.root, 'worktree', 'lock', locked)
    const other = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const folder = workFolder(repo.root, 'kit-1-a', { id: 'KIT-1' })
    const work = join(repo.root, '.work')
    readOnly.push(work)
    chmodSync(work, 0o555)
    const cards = { 'KIT-1': card('KIT-1', 'Released'), 'KIT-3': card('KIT-3', 'Released'), 'KIT-4': card('KIT-4', 'Released') }
    const { code, lines } = await run(repo.root, cards, { yes: true })
    const failedWith = (path: string, reason: RegExp) => about(lines, path).some((line) => /\bfailed\b/.test(line) && reason.test(line))
    expect({
      folder: [failedWith(folder, /EACCES|permission denied/i), existsSync(folder)],
      locked: [failedWith(locked, /locked/i), existsSync(locked), hasBranch(repo.root, 'feat/kit-3-x')],
      otherRemoved: !existsSync(other),
      code,
    }).toEqual({ folder: [true, true], locked: [true, true, true], otherRemoved: true, code: 1 })
  })

  it('T32: keeps a worktree whose TYPE differs from the card\'s Type, and one whose agent-common reports no Type, with distinct reasons', async () => {
    const repo = repository()
    const mismatch = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const skew = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const { lines } = await run(repo.root, { 'KIT-3': card('KIT-3', 'Released', 'Bug'), 'KIT-4': card('KIT-4', 'Released', null) }, { yes: true })
    const skewLine = listed(lines, skew)
    expect({
      mismatch: [listed(lines, mismatch).includes('Type mismatch'), existsSync(mismatch)],
      skew: [skewLine.includes("@aspiralabs/agent-common does not report the card's Type"), /Type mismatch|no Type/.test(skewLine), existsSync(skew)],
    }).toEqual({ mismatch: [true, true], skew: [true, false, true] })
  })
})

describe('kit cleanup from inside a ticket worktree', () => {
  it('T33: lists the worktree it runs in by its git top level, then removes it last with its branch and prints nothing after it', async () => {
    const repo = repository()
    const here = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const other = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const cards = { 'KIT-1': card('KIT-1', 'Released'), 'KIT-3': card('KIT-3', 'Released'), 'KIT-4': card('KIT-4', 'Released') }
    const topLevel = git(here, 'rev-parse', '--show-toplevel')
    process.chdir(here)
    const listing = await run(here, cards)
    const marked = [done, here, other].filter((path) => /\bdelete\b/.test(listed(listing.lines, path)))
    const after = await run(here, cards, { yes: true, only: marked })
    const last = after.lines.at(-1) ?? ''
    expect({
      topLevel,
      marksHere: /\bdelete\b/.test(listed(listing.lines, here)),
      gone: [done, here, other].filter((path) => existsSync(path)),
      branch: hasBranch(repo.root, 'feat/kit-3-x'),
      lastIsHere: about([last], here).length === 1 || last.includes('feat/kit-3-x'),
    }).toEqual({ topLevel: here, marksHere: true, gone: [], branch: false, lastIsHere: true })
  })

  it('T37: lists and deletes in the fixed order, with the worktree it runs in last', async () => {
    const repo = repository()
    const feature = worktree(repo, 'FEATURE-KIT-4', 'feat/kit-4-x')
    const bug = worktree(repo, 'BUG-KIT-3', 'fix/kit-3-x')
    const order = [
      workFolder(repo.root, 'kit-1-a', { id: 'KIT-1' }),
      workFolder(repo.root, 'kit-2-b', { id: 'KIT-2' }),
      workFolder(bug, 'kit-3-y', { id: 'KIT-3' }),
      bug,
      workFolder(feature, 'kit-4-z', { id: 'KIT-4' }),
      feature,
    ]
    const cards = { 'KIT-1': card('KIT-1', 'Released'), 'KIT-2': card('KIT-2', 'Released'), 'KIT-3': card('KIT-3', 'Released', 'Bug'), 'KIT-4': card('KIT-4', 'Released') }
    process.chdir(bug)
    const { lines } = await run(bug, cards, { yes: true })
    const listedOrder = [...order].sort((a, b) => firstIndex(lines, a) - firstIndex(lines, b))
    const lastMentioned = [...order].sort((a, b) => lastIndex(lines, a) - lastIndex(lines, b)).at(-1)
    expect({ listed: order.every((path) => firstIndex(lines, path) >= 0), listedOrder, lastMentioned }).toEqual({ listed: true, listedOrder: order, lastMentioned: bug })
  })
})

describe('kit cleanup with nothing to do', () => {
  it('T34: says there is nothing to clean when there are no working folders and no ticket worktrees', async () => {
    const repo = repository()
    const { code, lines } = await run(repo.root, {})
    expect({ says: lines.some((line) => /nothing to clean/i.test(line)), code }).toEqual({ says: true, code: 0 })
  })

  it('T35: lists kept and skipped folders, says nothing will be deleted, and never asks', async () => {
    const repo = repository()
    const open = workFolder(repo.root, 'kit-2-open', { id: 'KIT-2' })
    const bare = workFolder(repo.root, 'kit-5-a', 'none')
    const { code, lines } = await run(repo.root, { 'KIT-2': card('KIT-2', 'Ready: Spec') }, { ask: throwingReader })
    expect({
      open: /\bkeep\b/.test(listed(lines, open)),
      bare: /\bskip\b/.test(listed(lines, bare)),
      says: lines.some((line) => /nothing to delete|nothing will be deleted/i.test(line)),
      code,
    }).toEqual({ open: true, bare: true, says: true, code: 0 })
  })

  it('T36: reports targets removed between the listing and the confirmation as already gone and exits 0', async () => {
    const repo = repository()
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const wt = worktree(repo, 'FEATURE-KIT-3', 'feat/kit-3-x')
    const ask: Ask = async () => {
      rmSync(done, { recursive: true, force: true })
      git(repo.root, 'worktree', 'remove', wt)
      return 'y'
    }
    const { code, lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released'), 'KIT-3': card('KIT-3', 'Released') }, { ask })
    const alreadyGone = (path: string) => about(lines, path).some((line) => line.includes('already gone'))
    expect({ folder: alreadyGone(done), worktree: alreadyGone(wt), code }).toEqual({ folder: true, worktree: true, code: 0 })
  })
})

describe('kit cleanup preconditions', () => {
  it('T38: with no Feature Board in aspira.json, says so, deletes nothing and exits 1', async () => {
    const repo = repository({ board: false })
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const { code, lines } = await run(repo.root, { 'KIT-1': card('KIT-1', 'Released') }, { yes: true })
    expect({ says: lines.some((line) => /Feature Board/.test(line) && /aspira\.json/.test(line)), exists: existsSync(done), code }).toEqual({ says: true, exists: true, code: 1 })
  })

  it('T41: outside a git repository, cleans .work/ only and says worktrees were skipped', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'kit-cleanup-nogit-')))
    temporary.push(project)
    process.chdir(project)
    writeFileSync(join(project, 'aspira.json'), JSON.stringify({ board: BOARD }))
    const done = workFolder(project, 'kit-1-done', { id: 'KIT-1' })
    const { code, lines } = await run(project, { 'KIT-1': card('KIT-1', 'Released') }, { yes: true })
    expect({ gone: !existsSync(done), says: lines.some((line) => /worktree/i.test(line) && /not a git repository/i.test(line)), code }).toEqual({ gone: true, says: true, code: 0 })
  })
})

describe('kit cleanup --only', () => {
  it('T40: deletes only the confirmed paths and reports a newly marked one as not confirmed', async () => {
    const repo = repository()
    const done = workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    const open = workFolder(repo.root, 'kit-2-open', { id: 'KIT-2' })
    const cards: Cards = { 'KIT-1': card('KIT-1', 'Released'), 'KIT-2': card('KIT-2', 'Ready: Spec') }
    await run(repo.root, cards)
    const afterListing = [existsSync(done), existsSync(open)]
    cards['KIT-2'] = card('KIT-2', 'Released')
    const { code, lines } = await run(repo.root, cards, { yes: true, only: [done] })
    expect({
      afterListing,
      done: existsSync(done),
      open: existsSync(open),
      notConfirmed: about(lines, open).some((line) => line.includes('not confirmed')),
      code,
    }).toEqual({ afterListing: [true, true], done: false, open: true, notConfirmed: true, code: 0 })
  })
})

describe('kit cleanup and the board', () => {
  const amaro = join(dirname(dirname(kit)), 'packages', 'agents', 'implementor', 'node_modules', 'amaro')
  it.skipIf(!existsSync(amaro))('T39: reaches the board only through the resolve script, with <ref> --board <board URL>', async () => {
    const repo = repository()
    workFolder(repo.root, 'kit-1-done', { id: 'KIT-1' })
    workFolder(repo.root, 'kit-2-open', { id: 'KIT-2' })
    const modules = join(repo.root, 'node_modules')
    const common = join(modules, '@aspiralabs', 'agent-common')
    mkdirSync(join(common, 'scripts'), { recursive: true })
    symlinkSync(realpathSync(amaro), join(modules, 'amaro'))
    writeFileSync(join(common, 'package.json'), JSON.stringify({ name: '@aspiralabs/agent-common', version: '0.0.0', type: 'module' }))
    const calls = join(repo.tmp, 'resolver-calls.log')
    const script = join(common, 'scripts', 'resolve-ticket.ts')
    writeFileSync(
      script,
      [
        "import { appendFileSync } from 'node:fs'",
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(1)) + '\\n')`,
        'const id: string = process.argv[2]!.toUpperCase()',
        "const statuses: Record<string, string> = { 'KIT-1': 'Released', 'KIT-2': 'Ready: Spec' }",
        'console.log(`id=${id}\\ntitle=Ticket ${id}\\nurl=https://www.notion.so/x\\nstatus=${statuses[id] ?? \'\'}\\ntype=Feature\\nfolder=${id.toLowerCase()}-x`)',
        '',
      ].join('\n'),
    )
    await run(repo.root, lookupTicket, { yes: true })
    const invocations = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line)) : []
    const refs = invocations.map((argv) => (Array.isArray(argv) ? String(argv[1]).toUpperCase() : ''))
    expect({
      shapes: invocations.filter((argv) => !(Array.isArray(argv) && argv.length === 4 && argv[0] === script && argv[2] === '--board' && argv[3] === BOARD)),
      refs: [...new Set(refs)].sort(),
    }).toEqual({ shapes: [], refs: ['KIT-1', 'KIT-2'] })
  })
})
