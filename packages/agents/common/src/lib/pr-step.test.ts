// T18, T19 (F24, F25): the shared PR check (`checkPr`) and the two-stage set-then-move board step
// (`prStep`) that implementor `--verify --pr-url` and build-feature's Step 8 both use. Seam: the
// exported functions, with `gh` replaced by a fake executable on PATH (the boundary `hostPrChecks`
// calls through, TEST-007) and a real temp git repository. Nothing here mocks `git` or a module the
// kit owns (TEST-003). NOTION_TOKEN and NOTION_API_KEY are stripped from every environment passed in:
// neither function talks to Notion.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPr, prStep, readExpectedPr, writeExpectedPr } from './pr-step.ts'

const exec = promisify(execFile)

const BRANCH = 'feat/kit-2-x'
const ORIGIN = 'https://github.com/aspiralabs/kit.git'
const PR7 = 'https://github.com/aspiralabs/kit/pull/7'
const PR8 = 'https://github.com/aspiralabs/kit/pull/8'
const PR9 = 'https://github.com/aspiralabs/kit/pull/9'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-step-'))
  temps.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

/** A real checkout on BRANCH with origin set to the GitHub URl `checkPr` compares against. */
async function repo(): Promise<string> {
  const dir = await tempDir()
  const root = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', BRANCH, root])
  await git(root, 'remote', 'add', 'origin', ORIGIN)
  await writeFile(join(root, 'README.md'), '# kit\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', 'init')
  return root
}

const head = async (root: string): Promise<string> => (await git(root, 'rev-parse', 'HEAD')).stdout.trim()

/** A fake `gh`: answers `pr view <url> --json ...` from $GH_DIR/answer.json (or fails as $GH_DIR/fail
 * says), and logs every call under $GH_DIR/calls, one file per call, so a test can assert on them. */
const FAKE_GH = `#!/bin/bash
n=$(ls "$GH_DIR/calls" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "$GH_DIR/calls/$n"
if [ "$1 $2" = "pr view" ]; then
  if [ -f "$GH_DIR/fail" ]; then cat "$GH_DIR/fail" >&2; exit 1; fi
  cat "$GH_DIR/answer.json"
  exit 0
fi
exit 0
`

/** PATH with a fake gh (or without one, to simulate gh missing), and NOTION_TOKEN/NOTION_API_KEY stripped. */
async function ghEnv(options: { gh?: boolean } = {}): Promise<{ env: NodeJS.ProcessEnv; ghDir: string }> {
  const dir = await tempDir()
  const bin = join(dir, 'bin')
  const ghDir = join(dir, 'gh')
  await mkdir(join(ghDir, 'calls'), { recursive: true })
  await mkdir(bin, { recursive: true })
  if (options.gh !== false) await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, ...rest } = process.env
  return { env: { ...rest, PATH: `${bin}:/usr/bin:/bin`, GH_DIR: ghDir }, ghDir }
}

async function ghCalls(ghDir: string): Promise<string[][]> {
  const names = (await readdir(join(ghDir, 'calls'))).sort()
  return Promise.all(names.map(async (name) => (await readFile(join(ghDir, 'calls', name), 'utf8')).split('\n').filter((line) => line !== '')))
}

/** The `gh pr view` JSON a valid, open, same-repository PR on BRANCH answers with. */
const prAnswer = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ url: PR7, state: 'OPEN', headRefName: BRANCH, headRefOid: '', headRepository: 'aspiralabs/kit', headRepositoryOwner: 'aspiralabs', isCrossRepository: false, baseRefName: 'main', ...overrides })

describe('T18 F24: checkPr', () => {
  it('refuses a malformed --pr-url and a flag-like value before any gh call, with a usage message', async () => {
    const root = await repo()
    const { env, ghDir } = await ghEnv()
    for (const bad of ['https://github.com/aspiralabs/kit/pull/notanumber', '-x']) {
      const result = await checkPr({ url: bad, repo: root, branch: BRANCH, env })
      expect(result.kind).toBe('refused')
      expect(result.kind === 'refused' && /usage/i.test(result.message) && result.message.includes('--pr-url')).toBe(true)
    }
    expect(await ghCalls(ghDir)).toEqual([])
  })

  it('refuses a fork PR naming headRepository, and a closed PR naming state', async () => {
    const root = await repo()
    const sha = await head(root)
    const { env, ghDir } = await ghEnv()

    await writeFile(join(ghDir, 'answer.json'), prAnswer({ headRefOid: sha, isCrossRepository: true, headRepositoryOwner: 'someone', headRepository: 'someone/kit' }))
    const fork = await checkPr({ url: PR7, repo: root, branch: BRANCH, env })
    expect(fork.kind === 'refused' && fork.message.includes('headRepository')).toBe(true)

    await writeFile(join(ghDir, 'answer.json'), prAnswer({ headRefOid: sha, state: 'CLOSED' }))
    const closed = await checkPr({ url: PR7, repo: root, branch: BRANCH, env })
    expect(closed.kind === 'refused' && closed.message.includes('state')).toBe(true)
  })

  it('refuses a stale head naming headRefOid and the unpushed state, with the push command as Next action', async () => {
    const root = await repo()
    const { env, ghDir } = await ghEnv()
    await writeFile(join(ghDir, 'answer.json'), prAnswer({ headRefOid: '0'.repeat(40) }))
    const result = await checkPr({ url: PR7, repo: root, branch: BRANCH, env })
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.message.includes('headRefOid') && /unpushed|not pushed|push/i.test(result.message)).toBe(true)
    expect(result.kind === 'refused' ? result.next : undefined).toBe(`git push -u origin ${BRANCH}`)
  })

  it('blocks naming gh auth login when gh is missing, reports incomplete with the gh error line on a network failure, and neither sets or moves', async () => {
    const missingRoot = await repo()
    const missing = await ghEnv({ gh: false })
    const missingResult = await checkPr({ url: PR7, repo: missingRoot, branch: BRANCH, env: missing.env })
    expect(missingResult.kind).toBe('blocked')
    expect(missingResult.kind === 'blocked' && missingResult.message.includes('gh auth login')).toBe(true)

    const failRoot = await repo()
    const { env, ghDir } = await ghEnv()
    await writeFile(join(ghDir, 'fail'), 'error connecting to api.github.com\nmore detail on the next line\n')
    const failResult = await checkPr({ url: PR7, repo: failRoot, branch: BRANCH, env })
    expect(failResult.kind).toBe('incomplete')
    expect(failResult.kind === 'incomplete' && failResult.message.includes('error connecting to api.github.com') && !failResult.message.includes('more detail')).toBe(true)

    for (const result of [missingResult, failResult]) expect('action' in result || 'move' in result || 'set' in result).toBe(false)
  })
})

describe('T19 F25: prStep', () => {
  async function fixture() {
    const root = await repo()
    const sha = await head(root)
    const dir = await tempDir()
    const folder = join(dir, 'work')
    await mkdir(folder, { recursive: true })
    const { env, ghDir } = await ghEnv()
    await writeFile(join(ghDir, 'answer.json'), prAnswer({ headRefOid: sha }))
    return { root, folder, env }
  }

  it('the first call (PR empty) returns only a set action for the PR property and records the URL as expected', async () => {
    const { root, folder, env } = await fixture()
    const result = await prStep({ url: PR7, repo: root, branch: BRANCH, folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: null }, env })
    expect(result).toEqual({ kind: 'set', url: PR7 })
    expect(await readExpectedPr(folder)).toBe(PR7)
  })

  it('once ticket.md reads the URL the move to In Review: Implementation is returned (BOARD-005 order), and rerunning does not set the property again', async () => {
    const { root, folder, env } = await fixture()
    const input = { url: PR7, repo: root, branch: BRANCH, folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: PR7 }, env }
    const first = await prStep(input)
    const second = await prStep(input)
    expect([first, second]).toEqual([
      { kind: 'move', from: 'In Progress: Implementation', to: 'In Review: Implementation' },
      { kind: 'move', from: 'In Progress: Implementation', to: 'In Review: Implementation' },
    ])
  })

  it('already In Review: Implementation with that PR returns no action and status ready', async () => {
    const { root, folder, env } = await fixture()
    const result = await prStep({ url: PR7, repo: root, branch: BRANCH, folder, ticket: { id: 'KIT-2', status: 'In Review: Implementation', pr: PR7 }, env })
    expect(result).toEqual({ kind: 'ready' })
  })

  it('a different PR already set refuses naming both URLs; a pending URL with a new one refuses naming both and the --replace-pending command, replacing nothing', async () => {
    const { root, folder, env } = await fixture()
    const alreadySet = await prStep({ url: PR7, repo: root, branch: BRANCH, folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: PR8 }, env })
    expect(alreadySet.kind === 'refused' && alreadySet.message.includes(PR7) && alreadySet.message.includes(PR8)).toBe(true)

    const pending = await fixture()
    await prStep({ url: PR7, repo: pending.root, branch: BRANCH, folder: pending.folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: null }, env: pending.env })
    const replaced = await prStep({ url: PR9, repo: pending.root, branch: BRANCH, folder: pending.folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: null }, env: pending.env })
    expect(replaced.kind === 'refused' && replaced.message.includes(PR7) && replaced.message.includes(PR9) && replaced.message.includes('--replace-pending')).toBe(true)
    expect(await readExpectedPr(pending.folder)).toBe(PR7)
  })

  it('a PR property that reads back with neither the expected nor the given URL refuses naming all three', async () => {
    const { root, folder, env } = await fixture()
    await writeExpectedPr(folder, PR7)
    const result = await prStep({ url: PR7, repo: root, branch: BRANCH, folder, ticket: { id: 'KIT-2', status: 'In Progress: Implementation', pr: PR8 }, env })
    expect(result.kind === 'refused' && [PR7, PR8].every((url) => result.message.includes(url))).toBe(true)
  })
})
