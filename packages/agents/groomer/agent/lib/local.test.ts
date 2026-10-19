// The groomer's --local round loop (agent/lib/local.ts), driven through `runLocal` with the files a
// Claude Code session writes. No model is called: every model output here is a hand-written file.
//
// The contract these tests hold the driver to, in the ticket's working folder `<folder>`
// (`.work/<id>-<slug>/`, holding ticket.md and idea.md):
// - `runLocal({ folder, repoPath, guidelinesPath?, finish? }, { agentDir?, env? })` returns the next
//   step, and throws (rejects) on a refusal: missing knowledge (KnowledgeRequired, naming the page),
//   an answers file the driver refuses, an Idea summary that does not validate.
// - Knowledge is the folder `<folder>/groom.local/knowledge/` (REQUIRED.md and INDEX.md), or `guidelinesPath`.
// - Round n's output is `<folder>/groom/round-<n>.json` (roundSchema); the chat answers are
//   `<folder>/groom.local/answers-<n>.json`, a JSON array of `{ id, question, answer }` with at most one
//   `STOP` or `CONFIRM` entry; the page as the session fetched it in the board stage is
//   `<folder>/groom.local/page-<n>.md`; the Idea summary is `<folder>/groom/idea-summary.md`.
// - A round file lists the questions asked that round; an open question asked again keeps its id.
// - The board stage renders `<folder>/groom/trace/decisions.md` (the page the session writes to
//   Notion) and its step carries `runStatus`, the word the script hands to afterRun.
// - The round the run is on is `round` in `<folder>/.local/groomer/board.json`, the ticket-flow
//   state file (absent: round 1); the groom record is `<folder>/groom/trace/groom.json`.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderGroomPage } from '@aspiralabs/agent-common/lib/decisions'
import { writeGroomRecord } from '@aspiralabs/agent-common/lib/groom-record'
import { renderTicketMd } from '@aspiralabs/agent-common/lib/ticket'
import { runLocal } from './local.ts'

// The --local driver never calls Notion; an empty token makes sure no path through it can.
beforeEach(() => {
  vi.stubEnv('NOTION_TOKEN', '')
  vi.stubEnv('NOTION_API_KEY', '')
})

const IDEA = 'Let shoppers see why the cart stops at ten items.\n'
const REQUIRED = '# Agent Instructions\n\nREV-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-002 Verify every claim.\n'
const INTRO = 'Tick one option per question. Only ticks are read as answers: anything else you write on this page is kept under the Notes block at the end and never read as an answer. Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.'
const SEEDED = ['problem', 'who', 'done', 'intent', 'f-list', 'tests', 'constraints', 'out-of-scope', 'blast-radius', 'security', 'architecture', 'data', 'behavior', 'ui', 'acceptance']
const deps = { env: { KNOWLEDGE_REQUIRED: 'Agent Instructions, Review Verification' } }

const roundFile = (folder: string, n: number) => join(folder, 'groom', `round-${n}.json`)
const answersFile = (folder: string, n: number) => join(folder, 'groom.local', `answers-${n}.json`)
const pageFile = (folder: string, n: number) => join(folder, 'groom.local', `page-${n}.md`)
const summaryFile = (folder: string) => join(folder, 'groom', 'idea-summary.md')
const decisionsFile = (folder: string) => join(folder, 'groom', 'trace', 'decisions.md')

async function writeText(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}
const writeJson = (file: string, value: unknown) => writeText(file, JSON.stringify(value, null, 2))

/** A git repository with a tracked source file, and the ticket's working folder inside it. */
async function workspace(required = REQUIRED) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'groomer-local-')))
  execFileSync('git', ['init', '-q', repo])
  await writeText(join(repo, 'src', 'cart.ts'), 'export const LIMIT = 10\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: repo })
  const folder = join(repo, '.work', 'kit-9-cart-limit')
  await writeText(
    join(folder, 'ticket.md'),
    renderTicketMd({
      id: 'KIT-9',
      title: 'Cart limit',
      url: 'https://www.notion.so/kit-9',
      status: 'Grooming',
      type: 'Feature',
      area: [],
      idea: IDEA,
      pulledAt: '2026-10-11T09:00:00.000Z',
      pages: { 'Grooming Decisions': { id: 'gd', title: 'Grooming Decisions', url: 'https://www.notion.so/gd', lastEditedAt: '2026-10-11T09:00:00.000Z' } },
    }),
  )
  await writeText(join(folder, 'idea.md'), IDEA)
  await writeText(join(folder, 'groom.local', 'knowledge', 'REQUIRED.md'), required)
  await writeText(join(folder, 'groom.local', 'knowledge', 'INDEX.md'), '# Engineering Central\n')
  return { repo, folder, input: { folder, repoPath: repo } }
}

const question = (id: string, branch: string) => ({
  id,
  branch,
  question: `Which ${branch} choice applies to the cart limit (${id})?`,
  options: ['A', 'B'],
  recommended: 'A',
  reasoning: 'it matches what the cart does today',
  whyYours: 'it is a product call',
  facts: [{ path: 'src/cart.ts', line: 1 }],
  decidedBy: 'open' as const,
  answer: null,
})
const confirmed = (id: string, branch: string, answer: string) => ({ ...question(id, branch), decidedBy: 'author' as const, answer })

/** Every seeded branch visited, so nothing but open questions keeps Confirm away. */
const allVisited = () => SEEDED.map((id) => ({ id, state: 'visited' as const }))
const groomRecord = <D extends { decidedBy: 'open' | 'author' }>(round: number, decisions: D[], branches: { id: string; state: 'open' | 'visited' | 'closed' }[] = allVisited()) => ({
  decisions,
  branches,
  round,
  startedAt: '2026-10-11T09:00:00.000Z',
  open: decisions.filter((decision) => decision.decidedBy === 'open').length,
  page: { id: 'gd', url: 'https://www.notion.so/gd' },
  status: 'needs-author' as const,
  reasonCode: null,
  reason: null,
})

/** The page a first run created: the title, the intro and this run's marker, nothing else yet. */
const firstPage = `# Grooming Decisions\n\n${INTRO}\n\nRun: 2026-10-11T09:00:00.000Z local in progress\n`

/** The page with one more tick: the to-do line of `option` under the `## <id> — ` block. */
function tick(page: string, id: string, option: string): string {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${id} — `))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const at = lines.findIndex((line, index) => index > start && (end === -1 || index < end) && line.startsWith(`- [ ] ${option}`))
  if (start === -1 || at === -1) throw new Error(`no box for ${option} under ${id}`)
  return lines.map((line, index) => (index === at ? line.replace('- [ ] ', '- [x] ') : line)).join('\n')
}

/** The `## <id> — ` block of a rendered page, up to the next `## ` heading. */
function block(page: string, id: string): string {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${id} — `))
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The message of a refusal; a step that was returned instead is a failure. */
async function refusal(pending: Promise<unknown>): Promise<string> {
  const outcome = await pending.then((value: unknown) => ({ refused: false as const, value }), (error: unknown) => ({ refused: true as const, error }))
  if (!outcome.refused) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`)
  return outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)))
}

describe('the knowledge stage', () => {
  it('refuses to start without Review Verification, names it, and writes no round prompt', async () => {
    const { folder, input } = await workspace('# Agent Instructions\n\nREV-001 Read the rules.\n')
    const message = await refusal(runLocal(input, deps))
    const written = [...(await filesUnder(join(folder, 'groom.local'))), ...(await filesUnder(join(folder, 'groom')))].filter((file) => !file.startsWith('knowledge'))
    expect({ namesPage: message.includes('Review Verification'), roundFiles: written.filter((file) => /round/i.test(file)) }).toEqual({ namesPage: true, roundFiles: [] })
  })
})

describe('the answers of a chat round', () => {
  /** Round 1 asked Q1 and Q2 on the first run; the session is about to write the answers. */
  async function roundOneAsked() {
    const ws = await workspace()
    await writeJson(roundFile(ws.folder, 1), { round: 1, searched: ['cart limit'], facts: [{ path: 'src/cart.ts', line: 1 }], questions: [question('Q1', 'problem'), question('Q2', 'who')], branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'visited' }] })
    return ws
  }

  it('refuses an answer to an id the round does not have, naming the answers file and the id', async () => {
    const { folder, input } = await roundOneAsked()
    await writeJson(answersFile(folder, 1), [{ id: 'Q9', question: 'Which other choice applies?', answer: 'A' }])
    const message = await refusal(runLocal(input, deps))
    expect([message.includes(answersFile(folder, 1)), message.includes('Q9')]).toEqual([true, true])
  })

  it('refuses an answer that is not one of the question\'s options, naming the answers file and the id', async () => {
    const { folder, input } = await roundOneAsked()
    await writeJson(answersFile(folder, 1), [{ id: 'Q1', question: question('Q1', 'problem').question, answer: 'C' }])
    const message = await refusal(runLocal(input, deps))
    expect([message.includes(answersFile(folder, 1)), message.includes('Q1')]).toEqual([true, true])
  })

  it('refuses a Confirm while a question is still open', async () => {
    const { folder, input } = await roundOneAsked()
    await writeJson(answersFile(folder, 1), [
      { id: 'Q1', question: question('Q1', 'problem').question, answer: 'A' },
      { id: 'CONFIRM', question: 'Grooming is complete', answer: 'Confirm' },
    ])
    expect(await refusal(runLocal(input, deps))).toContain('Confirm was ticked but 1 question(s) are open; it is re-offered when they are answered')
  })

  it('ends the round stopped on a Stop: the board stage renders the page with Stop grooming unticked', async () => {
    const { folder, input } = await roundOneAsked()
    await writeJson(answersFile(folder, 1), [
      { id: 'Q1', question: question('Q1', 'problem').question, answer: 'A' },
      { id: 'STOP', question: 'Stop grooming', answer: 'Stop grooming' },
    ])
    await writeText(pageFile(folder, 1), firstPage)
    const step = await runLocal(input, deps)
    expect(step).toMatchObject({ stage: 'board', runStatus: 'needs-author', reasonCode: 'paused' })
    expect(await readFile(decisionsFile(folder), 'utf8')).toContain('- [ ] Stop grooming')
  })
})

describe('a confirm round', () => {
  /** Round 1 confirmed Q1; round 2 asked Q2, the last open question, and the human answered it and said yes to Confirm. */
  async function confirmedInChat() {
    const ws = await workspace()
    const previous = groomRecord(1, [confirmed('Q1', 'problem', 'A'), question('Q2', 'who')])
    await writeGroomRecord(ws.folder, previous)
    await writeText(pageFile(ws.folder, 2), renderGroomPage(previous, { date: '2026-10-11', notes: [] }))
    await writeJson(join(ws.folder, '.local', 'groomer', 'board.json'), { round: 2 })
    await writeJson(roundFile(ws.folder, 2), { round: 2, searched: ['cart limit'], facts: [], questions: [question('Q2', 'who')], branches: [] })
    await writeJson(answersFile(ws.folder, 2), [
      { id: 'Q2', question: question('Q2', 'who').question, answer: 'B' },
      { id: 'CONFIRM', question: 'Grooming is complete', answer: 'Confirm' },
    ])
    return ws
  }
  const summary = [
    'Groomed with /aspira-groomer on 2026-10-11',
    '',
    '### Decisions',
    '',
    `- **Q1 — ${question('Q1', 'problem').question}** Answer: A. Why: it matches what the cart does today.`,
    `- **Q2 — ${question('Q2', 'who').question}** Answer: B. Why: it matches what the cart does today.`,
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')

  it('asks for the Idea summary before the board stage', async () => {
    const { input } = await confirmedInChat()
    expect(await runLocal(input, deps)).toMatchObject({ stage: 'summary', round: 2 })
  })

  it('refuses an Idea summary that does not validate, naming its path and the reason', async () => {
    const { folder, input } = await confirmedInChat()
    await writeText(summaryFile(folder), `${summary}\n## Problem\n\nShoppers hit the limit.\n`)
    const message = await refusal(runLocal(input, deps))
    expect([message.includes(summaryFile(folder)), message.includes('Problem')]).toEqual([true, true])
  })

  it('asks for the Idea summary again on a resumed call while the file is missing', async () => {
    const { folder, input } = await confirmedInChat()
    await runLocal(input, deps)
    // The session was interrupted before it wrote the summary.
    await rm(summaryFile(folder), { force: true })
    expect(await runLocal(input, deps)).toMatchObject({ stage: 'summary', round: 2 })
  })
})

describe('ticks made on the page during a chat round', () => {
  it('lets the chat answer win on a question answered this round, reports the page tick, and merges a tick on any other question', async () => {
    const { folder, input } = await workspace()
    // Round 1 confirmed Q1 and left Q1.1 (its follow-up) and Q3 open; round 2 asked Q3 and the human answered A in chat.
    const previous = groomRecord(1, [confirmed('Q1', 'problem', 'A'), question('Q1.1', 'problem'), question('Q3', 'who')])
    await writeGroomRecord(folder, previous)
    await writeJson(join(folder, '.local', 'groomer', 'board.json'), { round: 2 })
    await writeJson(roundFile(folder, 2), { round: 2, searched: ['cart limit'], facts: [], questions: [question('Q3', 'who')], branches: [] })
    await writeJson(answersFile(folder, 2), [{ id: 'Q3', question: question('Q3', 'who').question, answer: 'A' }])
    // Meanwhile someone ticked B under Q3 and B under Q1.1 on the Notion page.
    await writeText(pageFile(folder, 2), tick(tick(renderGroomPage(previous, { date: '2026-10-11', notes: [] }), 'Q3', 'B'), 'Q1.1', 'B'))
    const step = await runLocal(input, deps)
    const page = await readFile(decisionsFile(folder), 'utf8')
    expect({
      reported: JSON.stringify(step).includes('Q3: page tick B overridden by the chat answer A'),
      q3: block(page, 'Q3').includes('Decided by the author: A.'),
      q11: block(page, 'Q1.1').includes('Decided by the author: B.'),
    }).toEqual({ reported: true, q3: true, q11: true })
  })
})

describe('resuming after an interruption', () => {
  it('starts the next round after a verified needs-author round, without asking its answers again', async () => {
    const { folder, input } = await workspace()
    const round1 = { round: 1, searched: ['cart limit'], facts: [{ path: 'src/cart.ts', line: 1 }], questions: [question('Q1', 'problem'), question('Q2', 'who')], branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'visited' }] }
    const after = groomRecord(1, [confirmed('Q1', 'problem', 'A'), question('Q2', 'who')], SEEDED.map((id) => ({ id, state: id === 'problem' || id === 'who' ? ('visited' as const) : ('open' as const) })))
    await writeJson(roundFile(folder, 1), round1)
    await writeJson(answersFile(folder, 1), [{ id: 'Q1', question: question('Q1', 'problem').question, answer: 'A' }])
    await writeText(pageFile(folder, 1), firstPage)
    await writeGroomRecord(folder, after)
    await writeText(decisionsFile(folder), renderGroomPage(after, { date: '2026-10-11', notes: [] }))
    await writeJson(join(folder, '.local', 'groomer', 'board.json'), { round: 2 })
    expect(await runLocal(input, deps)).toMatchObject({ stage: 'round', round: 2, task: { output: roundFile(folder, 2) } })
  })

  it('merges a tick made on the page between rounds into the next round\'s base, so the question is not asked again (KIT-23)', async () => {
    const { folder, input } = await workspace()
    const after = groomRecord(1, [confirmed('Q1', 'problem', 'A'), question('Q2', 'who')], SEEDED.map((id) => ({ id, state: id === 'problem' || id === 'who' ? ('visited' as const) : ('open' as const) })))
    await writeJson(roundFile(folder, 1), { round: 1, searched: ['cart limit'], facts: [{ path: 'src/cart.ts', line: 1 }], questions: [question('Q1', 'problem'), question('Q2', 'who')], branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'visited' }] })
    await writeJson(answersFile(folder, 1), [{ id: 'Q1', question: question('Q1', 'problem').question, answer: 'A' }])
    await writeText(pageFile(folder, 1), firstPage)
    await writeGroomRecord(folder, after)
    // The board stage of round 2 pulled the page again: the human ticked B under Q2 since round 1 ended.
    await writeText(decisionsFile(folder), tick(renderGroomPage(after, { date: '2026-10-11', notes: [] }), 'Q2', 'B'))
    await writeJson(join(folder, '.local', 'groomer', 'board.json'), { round: 2 })
    const step = await runLocal(input, deps)
    const base = JSON.parse(await readFile(join(folder, 'groom.local', 'base-2.json'), 'utf8')) as { decisions: { id: string; decidedBy: string; answer: string | null }[]; open: number }
    const prompt = step.stage === 'round' ? await readFile(step.task.prompt, 'utf8') : ''
    expect({
      stage: step.stage,
      q2: base.decisions.find((decision) => decision.id === 'Q2'),
      open: base.open,
      asksNone: prompt.includes('Open questions to ask again with their ids: none'),
    }).toMatchObject({ stage: 'round', q2: { decidedBy: 'author', answer: 'B' }, open: 0, asksNone: true })
  })
})
