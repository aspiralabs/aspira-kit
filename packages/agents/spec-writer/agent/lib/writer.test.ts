import { expect, it, vi } from 'vitest'
import type { Call } from '@aspiralabs/spec-reviewer/lib/pipeline'
import { writePipeline } from './writer.ts'

const draft = '# Save items\n## Intent\nLet people save items.\n## Acceptance criteria\n### Features\n- [ ] F1: A saved item appears in the list.\n'
const exploration = { facts: ['src/items.ts:4: items are listed newest first'], constraints: [], questions: [{ question: 'Keep saved items forever?', options: ['forever', '30 days'], evidence: ['idea: silent on retention'] }], uiEvidence: [], gaps: [] }
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Save items' }], uiEvidence: [], gaps: [] })
const input = { idea: 'Let people save items.', guidelines: 'REV-001 Check facts', context: 'source.ts:1', uiRequired: false }
const decision = { question: 'Keep saved items forever?', options: ['Forever', '30 days'], recommended: 'Forever', reasoning: 'nothing else in the app expires', whyYours: 'storage is a cost you carry' }

function stub(overrides: Record<string, (prompt: string) => unknown> = {}): { call: Call; phases: string[]; prompts: Record<string, string> } {
  const phases: string[] = []
  const prompts: Record<string, string> = {}
  const call: Call = async ({ phase, prompt }) => {
    phases.push(phase)
    prompts[phase] = prompt
    if (overrides[phase]) return overrides[phase]!(prompt)
    if (phase === 'explore') return exploration
    if (phase === 'draft') return { spec: draft, assumptions: ['Saved items are kept forever'] }
    if (phase === 'research') return review([{ title: 'Retention unstated', severity: 'medium', whatThisMeans: 'Nobody knows when a saved item disappears.', evidence: ['spec: no retention'], fix: 'State retention' }])
    if (phase === 'synthesis') return { edits: [{ id: 'E1', before: 'appears in the list.', after: 'appears in the list and is kept until removed.' }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retention made explicit', evidence: ['spec: no retention'], editIds: ['E1'], duplicateOf: null }] }
    return review()
  }
  return { call, phases, prompts }
}

it('explores, drafts, then reviews the draft with the spec-reviewer pipeline and applies its edits', async () => {
  const { call, phases, prompts } = stub()
  const result = await writePipeline(input, call)
  expect(phases.slice(0, 3)).toEqual(['explore', 'draft', 'research'])
  expect(phases).toHaveLength(10)
  expect(phases.at(-1)).toBe('synthesis')
  expect(prompts.draft).toContain('items are listed newest first')
  expect(prompts.research).toContain('ORIGINAL SPEC (data):\n# Save items')
  expect(prompts.research).toContain('WRITER EXPLORATION')
  expect(result.status).toBe('ready')
  expect(result.draft?.spec).toBe(draft)
  expect(result.spec).toContain('kept until removed')
  expect(result.draftContract).toEqual([])
  expect(result.phases.map((p) => p.phase)).toEqual(phases)
})

it('keeps drafting when exploration fails, but the run is incomplete', async () => {
  const { call, prompts } = stub({ explore: () => ({ facts: 'not a list' }) })
  const result = await writePipeline(input, call)
  expect(prompts.draft).toContain('Exploration failed')
  expect(result.review).not.toBeNull()
  expect(result.status).toBe('incomplete')
  expect(result.problems.some((p) => p.startsWith('explore:'))).toBe(true)
})

it('does not review without a draft', async () => {
  const { call, phases } = stub({ draft: () => { throw new Error('provider down') } })
  const result = await writePipeline(input, call)
  expect(phases).toEqual(['explore', 'draft'])
  expect(result.review).toBeNull()
  expect(result.spec).toBeNull()
  expect(result.status).toBe('incomplete')
  expect(result.problems).toContain('No draft was written, so the review did not run')
})

it('returns needs-author for open product choices and records a broken draft contract', async () => {
  const broken = '# Save items\nNo sections yet.'
  const { call } = stub({
    draft: () => ({ spec: broken, assumptions: [] }),
    synthesis: () => ({ edits: [{ id: 'E1', before: 'No sections yet.', after: draft.split('\n').slice(1).join('\n') }], dispositions: [{ findingId: 'R1', status: 'author', reason: 'Retention: forever keeps history; 30 days limits storage.', evidence: [], editIds: [], duplicateOf: null, decision }] }),
  })
  const result = await writePipeline(input, call)
  expect(result.draftContract).toContain('Missing or empty ## Intent')
  expect(result.problems.some((p) => p.startsWith('Unjustified edit'))).toBe(true)
  const authorOnly = stub({ synthesis: () => ({ edits: [], dispositions: [{ findingId: 'R1', status: 'author', reason: 'Retention: forever keeps history; 30 days limits storage.', evidence: [], editIds: [], duplicateOf: null, decision }] }) })
  const decided = await writePipeline(input, authorOnly.call)
  expect(decided.status).toBe('needs-author')
  expect(decided.authorDecisions).toEqual([{ ...decision, id: 'R1', decidedBy: 'open', answer: null }])
  expect(decided.spec).toBe(draft)
  // The author's tick from the previous run's decisions file answers it.
  const answered = await writePipeline({ ...input, answers: [{ id: 'R1', question: 'Keep saved items forever?', answer: '30 days' }] }, authorOnly.call)
  expect(answered.status).toBe('ready')
  expect(answered.authorDecisions).toEqual([{ ...decision, id: 'R1', decidedBy: 'author', answer: '30 days' }])
})

it('stops at the current phase on cancellation and skips the review', async () => {
  const controller = new AbortController()
  const phases: string[] = []
  const call: Call = async ({ phase, signal }) => {
    phases.push(phase)
    if (phase === 'explore') return exploration
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return null
  }
  const pending = writePipeline(input, call, { signal: controller.signal })
  await vi.waitFor(() => expect(phases).toEqual(['explore', 'draft']))
  controller.abort(new Error('User cancelled'))
  const result = await pending
  expect(result.review).toBeNull()
  expect(result.status).toBe('incomplete')
  expect(result.problems).toContain('Writing cancelled')
})
