// T17 (F21): which app directories a build touched, and which of those the code-analyzer already
// finished for this ticket and this implementor head. This is what Step 7 and Step 8 of the
// Playbook pick between (one app left to analyze vs. all of them clean), so changed-apps.ts and
// progress-note.ts's nextAction are tested together here against a real git repository (TEST-007:
// changedApps runs real `git diff` and `git merge-base`, not a mocked git).

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzedApps, changedApps } from './changed-apps'
import { nextAction } from './progress-note'

const exec = promisify(execFile)

let repo: string
let base: string
let head: string

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repo })
  return stdout.trim()
}

async function writeRounds(app: string, record: Record<string, unknown>) {
  const dir = join(repo, app, '.static-analysis')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'rounds.json'), JSON.stringify({ editedFiles: [], ...record }))
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'changed-apps-'))
  await git('init', '-q')
  await git('config', 'user.email', 't@t')
  await git('config', 'user.name', 't')
  await writeFile(join(repo, 'package.json'), '{"name":"root"}')
  await mkdir(join(repo, 'packages', 'a'), { recursive: true })
  await mkdir(join(repo, 'packages', 'b', 'src'), { recursive: true })
  await writeFile(join(repo, 'packages', 'a', 'package.json'), '{"name":"a"}')
  await writeFile(join(repo, 'packages', 'b', 'package.json'), '{"name":"b"}')
  await git('add', '.')
  await git('commit', '-q', '-m', 'C0: the plan repoCommit')
  base = await git('rev-parse', 'HEAD')

  await writeFile(join(repo, 'packages', 'b', 'src', 'x.ts'), 'export const x = 1\n')
  await writeFile(join(repo, 'packages', 'a', 'y.ts'), 'export const y = 1\n')
  await writeFile(join(repo, 'README.md'), '# changed\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'KIT-2: touch packages/b, packages/a and the root README')
  head = await git('rev-parse', 'HEAD')

  await writeRounds('packages/a', { status: 'ready', ticket: 'KIT-9', head })
  await writeRounds('packages/b', { status: 'ready', ticket: 'KIT-2', head })
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('changedApps (T17)', () => {
  it('maps every changed path to its nearest ancestor package.json directory, "." for the root, in localeCompare order', async () => {
    const apps = await changedApps(repo, base)
    expect(apps).toEqual(['.', 'packages/a', 'packages/b'])
  })
})

describe('analyzedApps (T17)', () => {
  it('counts only the app whose rounds.json matches this ticket, is ready, and is at or after the implementor head', async () => {
    const apps = await changedApps(repo, base)
    const analyzed = await analyzedApps(repo, apps, { ticket: 'KIT-2', head })
    expect(analyzed).toEqual(['packages/b'])
  })
})

describe('the Step 7 / Step 8 Next action built from changedApps and analyzedApps (T17)', () => {
  it('Step 7: one Run line, the code-analyzer command for the first unanalyzed app', async () => {
    const apps = await changedApps(repo, base)
    const analyzed = await analyzedApps(repo, apps, { ticket: 'KIT-2', head })
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'implementor', runStatus: 'ready', verified: true, liveStatus: 'In Progress: Implementation', apps, analyzedApps: analyzed })
    expect(action.run).toEqual(['/aspira-code-analyzer KIT-2 --app .'])
  })

  it('Step 8: once every app is analyzed, the ordered commit/push/PR/verify Run lines', async () => {
    const apps = await changedApps(repo, base)
    const action = nextAction({
      kind: 'run',
      id: 'KIT-2',
      skill: 'code-analyzer',
      runStatus: 'ready',
      verified: true,
      liveStatus: 'In Progress: Implementation',
      apps,
      analyzedApps: apps,
      title: 'Every skill writes a progress note',
      branch: 'feat/kit-2-x',
      prBodyFile: '.work/kit-2-x/pr-body.md',
      paths: ['packages/a/y.ts', 'packages/b/src/x.ts'],
    })
    const text = action.run.join('\n')
    expect(text).toMatch(/git add .* && git commit -m 'KIT-2: static analysis'/)
    expect(text).toContain('git push -u origin feat/kit-2-x')
    expect(text).toContain('gh pr create')
    expect(text).toContain('--body-file .work/kit-2-x/pr-body.md')
    expect(text).toContain('implementor.sh local KIT-2 --verify --pr-url <url>')
    // In order: commit, then push, then the PR, then the verify.
    const order = ['git commit', 'git push', 'gh pr create', '--verify --pr-url'].map((marker) => text.indexOf(marker))
    expect(order.every((position, i) => position >= 0 && (i === 0 || position > order[i - 1]!))).toBe(true)
  })
})
