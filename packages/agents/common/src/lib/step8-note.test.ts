// F21, F42 (implementation.md Blockers, wave 9): the --local driver's own end-of-run note picks
// Step 7 or Step 8 from what the build recorded. After a ready implementor or code-analyzer run on
// a ticket, the note's Next action is Step 7 for the first changed app the code analyzer has not
// finished for this ticket and head, and once every app is analyzed it is Step 8 as ordered `Run:`
// lines, with the PR body written to `.work/<id>-<slug>/pr-body.md` (writeStep8PrBody) and named in
// the `gh pr create` command. The branch is the one the implementor recorded (F22), never the card's
// current title. Seam: afterRun/verifyRun against a real temp git repository; no board, no Notion.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseNextAction } from './progress-note'
import { renderTicketMd, type TicketRecord } from './ticket'
import { afterRun, beforeRun, verifyRun, type BeforeRun, type DriverContext } from './ticket-driver'

const exec = promisify(execFile)
const BOARD = 'https://www.notion.so/board'
const BRANCH = 'feat/kit-2-every-skill-writes-a-progress-note'
const SLUG = 'kit-2-every-skill-writes-a-progress-note'

let repo: string
let folder: string
let head: string
let tick = 0

const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

function ticketRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return { id: 'KIT-2', title: 'Every skill writes a progress note', url: 'https://www.notion.so/kit-2', status: 'In Progress: Implementation', area: [], idea: '', pulledAt: new Date().toISOString(), pages: {}, dev: 'Claude', ...overrides }
}

async function writeTicket(record: TicketRecord) {
  const file = join(folder, 'ticket.md')
  await writeFile(file, renderTicketMd(record))
  tick += 1
  const stamp = new Date(Date.now() + tick * 2000)
  await utimes(file, stamp, stamp)
}

/** The session's side of the board stage, until the driver hands back the ticket. */
async function ready(context: DriverContext, initial: TicketRecord = ticketRecord()): Promise<BeforeRun & { kind: 'ticket' }> {
  let current = initial
  for (let i = 0; i < 8; i += 1) {
    const result = await beforeRun(context, { positional: 'KIT-2' })
    if (result.kind !== 'stage') return result as BeforeRun & { kind: 'ticket' }
    for (const action of result.stage.actions) {
      if (action.action === 'set' && action.name === 'Dev') current = { ...current, dev: action.value }
      if (action.action === 'move') current = { ...current, status: action.to }
      if (action.action === 'pull') await writeFile(action.file, `# ${action.title}\n\nStub.\n`).catch(() => undefined)
    }
    await writeTicket(current)
  }
  throw new Error('the board stage did not resolve')
}

async function implementorRecord(apps: string[]) {
  await mkdir(join(folder, 'plan.review', 'trace'), { recursive: true })
  await writeFile(join(folder, 'plan.review', 'trace', 'implementation-local.json'), JSON.stringify({ status: 'ready', reasonCode: null, reason: null, branch: BRANCH, apps, head }))
  await writeFile(join(folder, 'plan.review', 'implementation.md'), '# Implementation\n\n## Features\n\n| Feature | Tasks | Passing |\n| --- | --- | --- |\n| F1 | P1 | yes |\n')
}

async function analyzed(app: string, fields: { ticket?: string; status?: string } = {}) {
  await mkdir(join(repo, app, '.static-analysis'), { recursive: true })
  await writeFile(join(repo, app, '.static-analysis', 'rounds.json'), JSON.stringify({ status: fields.status ?? 'ready', reasonCode: null, ticket: fields.ticket ?? 'KIT-2', head }))
}

const nextOf = async () => parseNextAction(await readFile(join(folder, 'progress.md'), 'utf8'))

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'step8-note-')))
  await exec('git', ['init', '-q', '-b', BRANCH, repo])
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD }))
  await writeFile(join(repo, '.gitignore'), '.work/\n')
  for (const app of ['apps/api', 'apps/web']) {
    await mkdir(join(repo, app), { recursive: true })
    await writeFile(join(repo, app, 'package.json'), '{}\n')
  }
  await git('add', '.')
  await git('commit', '-qm', 'init')
  head = (await git('rev-parse', 'HEAD')).stdout.trim()
  folder = join(repo, '.work', SLUG)
  await mkdir(folder, { recursive: true })
  await writeTicket(ticketRecord())
  tick = 0
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('F21: a ready code-analyzer run picks Step 7 or Step 8 from the implementor record', () => {
  const context: DriverContext = { skill: 'code-analyzer', repo, env: {} }

  it('names Step 7 for the first changed app not analyzed for this ticket; another ticket\'s ready rounds.json does not count', async () => {
    const ctx = { ...context, repo }
    await implementorRecord(['apps/api', 'apps/web'])
    await analyzed('apps/api', { ticket: 'KIT-9' })
    await analyzed('apps/web')
    const before = await ready(ctx)
    await afterRun(ctx, before, { status: 'ready', exportDir: join(repo, 'apps/web', '.static-analysis'), verifyCommand: 'code-analyzer.sh local KIT-2 --verify' })
    const next = await nextOf()
    expect(next?.step).toBe('Step 7: static analysis')
    expect(next?.run).toEqual(['/aspira-code-analyzer KIT-2 --app apps/api --local'])
  })

  it('once every changed app is analyzed, names Step 8 as ordered commands on the recorded branch and writes pr-body.md', async () => {
    const ctx = { ...context, repo }
    await implementorRecord(['apps/api', 'apps/web'])
    await analyzed('apps/api')
    await analyzed('apps/web')
    await writeFile(join(repo, 'apps/web', 'fixed.ts'), 'export const fixed = 1\n')
    // The card was renamed after the build: the push still names the branch the implementor recorded (F22).
    const renamed = ticketRecord({ title: 'A renamed card' })
    await writeTicket(renamed)
    const before = await ready(ctx, renamed)
    await afterRun(ctx, before, { status: 'ready', exportDir: join(repo, 'apps/web', '.static-analysis'), verifyCommand: 'code-analyzer.sh local KIT-2 --verify' })
    const next = await nextOf()
    expect(next?.step).toBe('Step 8: open the pull request')
    expect(next?.run).toEqual([
      "git add -- 'apps/web/fixed.ts' && git commit -m 'KIT-2: static analysis'",
      `git push -u origin ${BRANCH}`,
      `gh pr create --base main --head ${BRANCH} --title 'A renamed card' --body-file .work/${SLUG}/pr-body.md`,
      '.claude/skills/aspira-implementor/scripts/implementor.sh local KIT-2 --verify --pr-url <url>',
    ])
    expect(existsSync(join(folder, 'pr-body.md'))).toBe(true)
    const body = await readFile(join(folder, 'pr-body.md'), 'utf8')
    expect(body.indexOf('## Summary')).toBeLessThan(body.indexOf('## Evidence'))
    expect(body.indexOf('## Evidence')).toBeLessThan(body.indexOf('## Merge Danger'))
    expect(body).toContain('https://www.notion.so/kit-2')
  })

  it('never stages an untracked .env* file in Step 8 (AVA1.1): the git add names only the safe path, and Open issues names each left-out secrets file', async () => {
    const ctx = { ...context, repo }
    await implementorRecord(['apps/api', 'apps/web'])
    await analyzed('apps/api')
    await analyzed('apps/web')
    await writeFile(join(repo, 'apps/web', 'fixed.ts'), 'export const fixed = 1\n')
    await writeFile(join(repo, '.env.local'), 'NOTION_TOKEN=ntn_not_a_real_token_value\n')
    await writeFile(join(repo, 'apps/web', '.env'), 'SECRET=also_not_real\n')
    const before = await ready(ctx)
    await afterRun(ctx, before, { status: 'ready', exportDir: join(repo, 'apps/web', '.static-analysis'), verifyCommand: 'code-analyzer.sh local KIT-2 --verify' })
    const next = await nextOf()
    expect(next?.run[0]).toBe("git add -- 'apps/web/fixed.ts' && git commit -m 'KIT-2: static analysis'")
    expect(next?.run.join('\n')).not.toContain('.env')
    const note = await readFile(join(folder, 'progress.md'), 'utf8')
    const openIssues = note.slice(note.indexOf('## Open issues'), note.indexOf('## Next action'))
    expect(openIssues).toContain('.env.local')
    expect(openIssues).toContain('apps/web/.env')
  })

  it('a code-analyzer run that is not ready names neither Step 7 nor Step 8 (F27)', async () => {
    const ctx = { ...context, repo }
    await implementorRecord(['apps/api'])
    const before = await ready(ctx)
    await afterRun(ctx, before, { status: 'incomplete', exportDir: join(repo, 'apps/api', '.static-analysis'), verifyCommand: 'code-analyzer.sh local KIT-2 --verify' })
    const next = await nextOf()
    expect(next?.step ?? '').not.toMatch(/Step [78]/)
    expect(existsSync(join(folder, 'pr-body.md'))).toBe(false)
  })
})

describe('F21: a verified ready implementor run names Step 7', () => {
  it('after the Implementation push reads back, the note names Step 7 for the first changed app', async () => {
    const ctx: DriverContext = { skill: 'implementor', repo, env: {} }
    await implementorRecord(['apps/web'])
    await writeFile(join(folder, 'plan.review', 'plan.reviewed.md'), '# Plan\n')
    const before = await ready(ctx)
    const end = await afterRun(ctx, before, { status: 'ready', exportDir: join(folder, 'plan.review'), verifyCommand: 'implementor.sh local KIT-2 --verify' })
    expect(end.board.actions.map((action) => action.action)).toEqual(['push'])
    // The session performs the push: the Implementation row lands in ticket.md.
    const record = ticketRecord({ status: before.ticket.status })
    await writeTicket({ ...record, pages: { Implementation: { id: 'impl', title: 'Implementation', url: 'https://www.notion.so/impl', lastEditedAt: new Date(Date.now() + 60_000).toISOString() } } })
    const verified = await verifyRun(ctx, { positional: 'KIT-2' }, (f) => join(f, 'plan.review'))
    expect(verified.verified).toBe(true)
    const next = await nextOf()
    expect(next?.step).toBe('Step 7: static analysis')
    expect(next?.run).toEqual(['/aspira-code-analyzer KIT-2 --app apps/web --local'])
  })
})
