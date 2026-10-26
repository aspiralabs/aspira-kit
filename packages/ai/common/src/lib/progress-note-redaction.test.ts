// T13 (F18): a run's trace carries free text an attacker or a pasted secret controls (a decision's
// reason, an error line). progress.md and any other place that echoes the same trace (here: a
// report header built from the same reason text) must redact it the same way, using the widened
// redact(text, repo, { app, extra }) that P13 moves into agent-common: it reads the repository
// root's .env* files, the app directory's .env* files (aspira.json `app`), and any extra literal
// values the caller names (the NOTION_TOKEN currently in use), never just the token-shaped patterns.
//
// SEC-010: nothing attacker- or secret-controlled is echoed unescaped; this test is the seam that
// proves it end to end rather than unit-testing redact() in isolation (that belongs to P13's own
// tests once redact.ts moves here).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProgressNote } from './progress-note'
import { redact } from './redact'

let repo: string
let folder: string
const APP_SECRET = 'correcthorse42'
const NOTION_TOKEN = 'ntn_abc123'
const REASON = `research failed: ${APP_SECRET} rejected`

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'progress-note-redact-'))
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board', app: 'apps/web' }))
  await mkdir(join(repo, 'apps', 'web'), { recursive: true })
  await writeFile(join(repo, 'apps', 'web', '.env.local'), `SHARED_PASS=${APP_SECRET}\n`)
  await writeFile(join(repo, '.env.local'), `NOTION_TOKEN=${NOTION_TOKEN}\n`)
  folder = join(repo, '.work', 'kit-2-every-skill')
  await mkdir(join(folder, 'plan.review', 'trace'), { recursive: true })
  await writeFile(join(folder, 'ticket.md'), '# KIT-2: Every skill writes a progress note\n')
  await writeFile(join(folder, 'plan.review', 'trace', 'review.json'), JSON.stringify({ status: 'incomplete', reason: REASON }))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('writeProgressNote redacts free text from a trace (T13)', () => {
  it('replaces the app .env value in progress.md with [redacted], never the raw value', async () => {
    await writeProgressNote({
      folder,
      repo,
      app: 'apps/web',
      notionToken: NOTION_TOKEN,
      note: { id: 'KIT-2', title: 'Every skill writes a progress note', skill: 'planner', runId: 'r1', runStatus: 'incomplete', status: 'In Progress: Plan', expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [REASON], nextAction: { step: 'rerun the stage', do: [], run: ['/aspira-planner KIT-2'], session: '~/.claude/skills/aspira-planner/scripts/planner.sh local KIT-2' } },
    })
    const text = await readFile(join(folder, 'progress.md'), 'utf8')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain(APP_SECRET)
    expect(text).toContain('~/.claude/skills/aspira-planner/scripts/planner.sh local KIT-2')
    expect(text).toContain('/aspira-planner KIT-2')
  })

  it('redacts the NOTION_TOKEN value in use wherever it would otherwise appear', async () => {
    await writeProgressNote({
      folder,
      repo,
      app: 'apps/web',
      notionToken: NOTION_TOKEN,
      note: { id: 'KIT-2', title: 'Every skill writes a progress note', skill: 'planner', runId: 'r1', runStatus: 'incomplete', status: 'In Progress: Plan', expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [`token in use: ${NOTION_TOKEN}`], nextAction: null },
    })
    const text = await readFile(join(folder, 'progress.md'), 'utf8')
    expect(text).not.toContain(NOTION_TOKEN)
  })
})

describe('the same trace reason, rendered as a final report header through redact(), is scrubbed the same way', () => {
  it('replaces the app .env value with [redacted] in the report header text', async () => {
    const header = `Run status: incomplete (${REASON})`
    const redacted = await redact(header, repo, { app: 'apps/web', extra: [NOTION_TOKEN] })
    expect(redacted).toContain('[redacted]')
    expect(redacted).not.toContain(APP_SECRET)
  })

  it('replaces the NOTION_TOKEN value in use with [redacted] in the report header text', async () => {
    const header = `Run status: incomplete (token ${NOTION_TOKEN} rejected)`
    const redacted = await redact(header, repo, { app: 'apps/web', extra: [NOTION_TOKEN] })
    expect(redacted).not.toContain(NOTION_TOKEN)
  })
})
