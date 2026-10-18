// T11: --take-recommended at the spec-writer's --local export seam (agent/lib/local.ts runLocal).
// The written spec's status comes from the draft review's own status (runner.ts renderDecisionsFile
// at trace/decisions.md, writer.ts: `status = problems.length || !review ? 'incomplete' : review.status`),
// and the review's status is 'needs-author' while a decision stays open. With the flag, an open
// decision from the draft review is taken as the agent's recommended option instead of waiting on
// the author (KIT-11 F10), so export status becomes 'ready'. No decision is ever decidedBy 'author'
// unless an author actually ticked it.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))
import { runLocal, type LocalInput } from './local.ts'
import { writeSnapshot } from './snapshot.test-helper.ts'

const draft = '# Save items\n## Intent\nLet people save items.\n## Acceptance criteria\n### Features\n- [ ] F1: A saved item appears in the list.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Save items' }], uiEvidence: [], gaps: [] })
/** An open decision from the draft review (T11): nobody, agent or author, has answered it yet. */
const decision = { question: 'Do saved items expire?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'cookbooks already keep everything until removed', whyYours: 'it decides what members pay storage for' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-take-recommended-'))
  const ideaPath = join(dir, 'idea.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(ideaPath, 'Let people save items.')
  await writeSnapshot(guidelinesPath)
  return { dir, ideaPath, input: { ideaPath, guidelinesPath, repoPath: dir, uiRequired: false } }
}

/** Drives a fixture through explore, draft and the draft review, with one open decision, to export. */
async function exportWithOpenDecision(input: LocalInput) {
  const explore = await runLocal(input)
  if (!explore.pending) throw new Error('expected pending')
  await writeFile(explore.tasks[0]!.output, JSON.stringify({ facts: ['src/items.ts:4: newest first'], constraints: [], questions: [], uiEvidence: [], gaps: [] }))

  const drafting = await runLocal(input)
  if (!drafting.pending) throw new Error('expected pending')
  await writeFile(drafting.tasks[0]!.output, JSON.stringify({ spec: draft, assumptions: [] }))

  const research = await runLocal(input)
  if (!research.pending) throw new Error('expected pending')
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([{ title: 'Retention unstated', severity: 'low', whatThisMeans: 'Nobody knows when a saved item disappears.', evidence: ['spec: list'], fix: 'State retention' }])))

  const specialists = await runLocal(input)
  if (!specialists.pending) throw new Error('expected pending')
  for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))

  const synthesis = await runLocal(input)
  if (!synthesis.pending) throw new Error('expected pending')
  await writeFile(synthesis.tasks[0]!.output, JSON.stringify({
    edits: [],
    dispositions: [{ findingId: 'R1', status: 'author', reason: 'Retention is a product choice, not an engineering one', evidence: ['spec: list'], editIds: [], duplicateOf: null, decision }],
  }))

  const done = await runLocal(input)
  if (done.pending) throw new Error('expected an export')
  return done
}

it('takes the open decision as the agent\'s recommended option with --take-recommended, so the spec exports ready', async () => {
  const { dir, input } = await setup()
  const withFlag: LocalInput & { takeRecommended: boolean } = { ...input, takeRecommended: true }
  const done = await exportWithOpenDecision(withFlag)

  expect(done.status).toBe('ready')
  expect(done.authorDecisions).toHaveLength(1)
  expect(done.authorDecisions[0]).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })
  expect(done.authorDecisions.some((entry) => entry.decidedBy === 'author')).toBe(false)

  const report = JSON.parse(await readFile(join(dir, 'spec.written/trace/review.json'), 'utf8')) as { status: string; authorDecisions: { decidedBy: string; answer: string }[] }
  expect(report.status).toBe('ready')
  expect(report.authorDecisions[0]).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })
  expect(report.authorDecisions.some((entry) => entry.decidedBy === 'author')).toBe(false)
})

it('leaves the decision open without --take-recommended (regression)', async () => {
  const { dir, input } = await setup()
  const done = await exportWithOpenDecision(input)

  expect(done.status).toBe('needs-author')
  expect(done.authorDecisions[0]).toMatchObject({ decidedBy: 'open', answer: null })

  const report = JSON.parse(await readFile(join(dir, 'spec.written/trace/review.json'), 'utf8')) as { status: string }
  expect(report.status).toBe('needs-author')
})
