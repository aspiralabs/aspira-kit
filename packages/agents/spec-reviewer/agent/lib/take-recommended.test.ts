// T10: --take-recommended at the spec-reviewer's --local export seam (agent/lib/local.ts runLocal).
// Reconciliation keys an open decision by the finding id (pipeline.ts authorDecisionsOf: `id:
// d.findingId`), and export status is 'needs-author' while any decision stays open (pipeline.ts
// `openDecisions(authorDecisions).length ? 'needs-author' : 'ready'`). With the flag, an open
// decision is taken as the agent's recommended option (decisions.ts takenDecision) instead of
// waiting on the author (KIT-11 F10), so export status becomes 'ready'.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))
import { runLocal, type LocalInput } from './local.ts'

// A spec that already satisfies the business spec contract (common/lib/spec.ts checkBusinessSpec),
// since the author disposition below carries no edit to fix it up.
const SPEC = '# Feature\n## Intent\nPersist a named item.\n## Acceptance criteria\n### Features\n- [ ] F1: An authorized user can save an item once.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Feature' }], uiEvidence: [], gaps: [] })
const finding = (title: string) => ({ title, severity: 'low', whatThisMeans: 'Members would not know when a saved item disappears.', evidence: ['spec: Feature'], fix: 'State retention' })
/** An open decision keyed by the finding id (T10): nobody, agent or author, has answered it yet. */
const decision = { question: 'Should saved items be kept forever?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'cookbooks keep everything until removed', whyYours: 'it decides what members pay storage for' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-review-take-recommended-'))
  const specPath = join(dir, 'spec.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(specPath, SPEC)
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  return { dir, specPath, guidelinesPath, input: { specPath, guidelinesPath, repoPath: dir, uiRequired: false } }
}

/** Drives a fixture through research, the specialists and reconciliation, with one open author decision, to export. */
async function exportWithOpenDecision(input: LocalInput) {
  const research = await runLocal(input)
  if (!research.pending) throw new Error('expected pending')
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([finding('Retention unstated')])))

  const specialists = await runLocal(input)
  if (!specialists.pending) throw new Error('expected pending')
  for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))

  const synthesis = await runLocal(input)
  if (!synthesis.pending) throw new Error('expected pending')
  await writeFile(synthesis.tasks[0]!.output, JSON.stringify({
    edits: [],
    dispositions: [{ findingId: 'R1', status: 'author', reason: 'Retention is a product choice, not an engineering one', evidence: ['spec: Original'], editIds: [], duplicateOf: null, decision }],
  }))

  const done = await runLocal(input)
  if (done.pending) throw new Error('expected an export')
  return done
}

it('takes the open decision as the agent\'s recommended option with --take-recommended, so the review exports ready', async () => {
  const { dir, input } = await setup()
  const withFlag: LocalInput & { takeRecommended: boolean } = { ...input, takeRecommended: true }
  const done = await exportWithOpenDecision(withFlag)

  expect(done.status).toBe('ready')
  expect(done.authorDecisions).toHaveLength(1)
  expect(done.authorDecisions[0]).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })

  const report = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8')) as { status: string; authorDecisions: { decidedBy: string; answer: string }[] }
  expect(report.status).toBe('ready')
  expect(report.authorDecisions[0]).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })
})

it('leaves the decision open without --take-recommended (regression)', async () => {
  const { dir, input } = await setup()
  const done = await exportWithOpenDecision(input)

  expect(done.status).toBe('needs-author')
  expect(done.authorDecisions[0]).toMatchObject({ decidedBy: 'open', answer: null })

  const report = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8')) as { status: string }
  expect(report.status).toBe('needs-author')
})
