// T8: --take-recommended at the groomer's --local driver seam (agent/lib/local.ts runLocal, run by
// `groomer.sh local <ID> --take-recommended`). The exit-criterion branches (rounds.ts EXIT_CRITERIA:
// 'problem', 'who', 'done') stay the author's: a round's open question on one of them is always
// asked in chat. Every other open question (rounds.ts: "a round asks open questions only") is, with
// the flag, taken as the agent's recommended option (common/lib/decisions.ts takenDecision) instead
// of waiting on the author (KIT-11 F10), so the next chat stage asks only the exit-criterion
// questions still open, and groom.json records the rest decidedBy 'agent'.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { renderGroomPage } from '@aspiralabs/agent-common/lib/decisions'
import { readGroomRecord, writeGroomRecord } from '@aspiralabs/agent-common/lib/groom-record'
import { renderTicketMd } from '@aspiralabs/agent-common/lib/ticket'
import { runLocal, type LocalInput } from './local.ts'

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
const decisionsFile = (folder: string) => join(folder, 'groom', 'trace', 'decisions.md')

async function writeText(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}
const writeJson = (file: string, value: unknown) => writeText(file, JSON.stringify(value, null, 2))

/** A git repository with a tracked source file, and the ticket's working folder inside it. */
async function workspace() {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'groomer-take-recommended-')))
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
  await writeText(join(folder, 'groom.local', 'knowledge', 'REQUIRED.md'), REQUIRED)
  await writeText(join(folder, 'groom.local', 'knowledge', 'INDEX.md'), '# Engineering Central\n')
  return { repo, folder, input: { folder, repoPath: repo } satisfies LocalInput }
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

/** The `## <id> — ` block of a rendered page, up to the next `## ` heading. */
function block(page: string, id: string): string {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${id} — `))
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** Round 1 asks Q1 on the exit-criterion branch 'problem' and Q2 on the ordinary branch 'constraints', both open. */
async function roundOneAsked() {
  const ws = await workspace()
  await writeJson(roundFile(ws.folder, 1), {
    round: 1,
    searched: ['cart limit'],
    facts: [{ path: 'src/cart.ts', line: 1 }],
    questions: [question('Q1', 'problem'), question('Q2', 'constraints')],
    branches: [{ id: 'problem', state: 'visited' }, { id: 'constraints', state: 'visited' }],
  })
  return ws
}

it('with --take-recommended, takes Q2 (an ordinary branch) as the agent\'s recommended option, and leaves Q1 (an exit-criterion branch) for the chat round', async () => {
  const { folder, input } = await roundOneAsked()
  const withFlag: LocalInput & { takeRecommended: boolean } = { ...input, takeRecommended: true }

  const answers = await runLocal(withFlag, deps)
  if (answers.stage !== 'answers') throw new Error(`expected the answers stage, got ${JSON.stringify(answers)}`)
  expect(answers.questions.map((q) => q.id)).toEqual(['Q1'])

  // Nobody has answered Q1 in chat yet; this just advances the driver past the round.
  await writeJson(answersFile(folder, 1), [])
  const fetch = await runLocal(withFlag, deps)
  expect(fetch).toMatchObject({ stage: 'board' })
  await writeText(pageFile(folder, 1), firstPage)
  const board = await runLocal(withFlag, deps)
  expect(board).toMatchObject({ stage: 'board', runStatus: 'needs-author' })

  const record = await readGroomRecord(folder)
  expect(record?.decisions.find((decision) => decision.id === 'Q2')).toMatchObject({ decidedBy: 'agent', answer: 'A' })
  expect(record?.decisions.find((decision) => decision.id === 'Q1')).toMatchObject({ decidedBy: 'open', answer: null })

  const page = await readFile(decisionsFile(folder), 'utf8')
  expect(block(page, 'Q2')).toContain('Taken by the agent')
})

it('without the flag, both Q1 and Q2 stay open and are asked in chat (regression)', async () => {
  const { input } = await roundOneAsked()
  const answers = await runLocal(input, deps)
  if (answers.stage !== 'answers') throw new Error(`expected the answers stage, got ${JSON.stringify(answers)}`)
  expect(answers.questions.map((q) => q.id).sort()).toEqual(['Q1', 'Q2'])
})

it('lists only the author\'s decisions in the Idea summary prompt input, not the agent\'s', async () => {
  const ws = await workspace()
  // Round 1 confirmed Q1 (an exit-criterion branch) and visited every branch; round 2 asks Q2 on an ordinary branch.
  const previous = groomRecord(1, [confirmed('Q1', 'problem', 'A')])
  await writeGroomRecord(ws.folder, previous)
  await writeText(pageFile(ws.folder, 2), renderGroomPage(previous, { date: '2026-10-11', notes: [] }))
  await writeJson(join(ws.folder, '.local', 'groomer', 'board.json'), { round: 2 })
  await writeJson(roundFile(ws.folder, 2), { round: 2, searched: ['cart limit'], facts: [], questions: [question('Q2', 'constraints')], branches: [] })
  const withFlag: LocalInput & { takeRecommended: boolean } = { ...ws.input, takeRecommended: true }

  // Q2 is taken by the agent immediately, so no question remains open and Confirm is offered.
  const answers = await runLocal(withFlag, deps)
  expect(answers).toMatchObject({ stage: 'answers', confirm: true })

  await writeJson(answersFile(ws.folder, 2), [{ id: 'CONFIRM', question: 'Grooming is complete', answer: 'Confirm' }])
  let summary: Awaited<ReturnType<typeof runLocal>>
  try {
    summary = await runLocal(withFlag, deps)
  } catch (error) {
    throw new Error(`expected the summary stage, got a refusal: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (summary.stage !== 'summary') throw new Error(`expected the summary stage, got ${JSON.stringify(summary)}`)
  const prompt = await readFile(summary.task.prompt, 'utf8')
  expect(prompt).toContain('(Q1)')
  expect(prompt).not.toContain('(Q1, Q2)')
})
