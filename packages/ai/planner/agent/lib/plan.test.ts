import { describe, expect, it } from 'vitest'
import { decisionSchema, mergeDecisions, planSchema, problemSeverity, renderChecks, renderPlan, researchSchema, touchesUi, validatePlan } from './plan.ts'
import { files, spec, validPlan } from './fixtures.test-helper.ts'

it('accepts concrete test-first tasks and renders separate unit/integration checklists', () => {
  const plan = validPlan()
  expect(validatePlan(plan, spec, files)).toEqual([])
  const text = renderPlan(plan, 'ready', { specPath: '/spec.md', commit: 'abc', dirty: false }, [])
  expect(text).toContain('modify `src/items.ts`')
  expect(text).toContain('### Unit tests')
  expect(text).toContain('### Integration tests')
  expect(text).toContain('[F1]')
})

it('rejects broken coverage, IDs, cycles and non-test-first implementation', () => {
  for (const mutate of [
    (plan: ReturnType<typeof validPlan>) => { plan.tasks[1]!.dependsOn = [] },
    (plan: ReturnType<typeof validPlan>) => { plan.tasks[0]!.dependsOn = ['P2'] },
    (plan: ReturnType<typeof validPlan>) => { plan.tasks[1]!.id = 'P1' },
    (plan: ReturnType<typeof validPlan>) => { plan.tests[1]!.id = 'T1' },
    (plan: ReturnType<typeof validPlan>) => { plan.tests[1]!.kind = 'unit' },
    (plan: ReturnType<typeof validPlan>) => { plan.tests[1]!.featureIds = ['F9'] },
    (plan: ReturnType<typeof validPlan>) => { plan.tasks[2]!.dependsOn = [] },
    (plan: ReturnType<typeof validPlan>) => { plan.tasks[0]!.changes[0]!.path = 'src/items.ts' },
  ]) {
    const plan = validPlan(); mutate(plan)
    expect(validatePlan(plan, spec, files).length).toBeGreaterThan(0)
  }
  expect(validatePlan(validPlan(), spec + '- [ ] F2: Items can be removed.\n', files)).toContain('No implementation maps to F2')
})

it('rejects unsafe paths, nonexistent targets, create collisions and fabricated evidence', () => {
  for (const path of ['../outside.ts', '/absolute.ts', '.env.local', 'C:\\outside.ts']) {
    const plan = validPlan(); plan.tasks[1]!.changes[0]!.path = path
    expect(validatePlan(plan, spec, files)).toContain(`Unsafe path: ${path}`)
  }
  const missing = validPlan(); missing.tasks[1]!.changes[0]!.path = 'src/missing.ts'
  expect(validatePlan(missing, spec, files)).toContain('Missing modify target: src/missing.ts')
  const collision = validPlan(); collision.tasks[1]!.changes[0]!.operation = 'create'
  expect(validatePlan(collision, spec, files)).toContain('Create target already exists: src/items.ts')
  const evidence = validPlan(); evidence.tasks[1]!.changes[0]!.evidence = ['src/items.ts:999']
  expect(validatePlan(evidence, spec, files)).toContain('No valid source evidence: P2/src/items.ts')
})

it('accepts line-range citations that stay inside the file and rejects ranges that do not', () => {
  const lines = files.get('src/items.ts')!.split('\n').length
  const range = validPlan(); range.tasks[1]!.changes[0]!.evidence = [`src/items.ts:1-${lines}`]
  expect(validatePlan(range, spec, files)).toEqual([])
  for (const citation of [`src/items.ts:1-${lines + 1}`, 'src/items.ts:3-2', 'src/items.ts:0-1']) {
    const bad = validPlan(); bad.tasks[1]!.changes[0]!.evidence = [citation]
    expect(validatePlan(bad, spec, files)).toContain('No valid source evidence: P2/src/items.ts')
  }
})

it('lets a plan change tracked lockfiles and .npmrc that are not indexed, but never secrets, and names directory targets', () => {
  const tracked = new Set([...files.keys(), 'pnpm-lock.yaml', 'app/.npmrc', 'app/pnpm-lock.yaml'])
  const plan = validPlan()
  plan.tasks[1]!.changes.push(
    { operation: 'modify', path: 'pnpm-lock.yaml', symbols: ['lockfile'], instructions: 'Regenerate with pnpm install.', evidence: ['package.json:1'] },
    { operation: 'delete', path: 'app/pnpm-lock.yaml', symbols: ['lockfile'], instructions: 'Replaced by the root lockfile.', evidence: ['package.json:1'] },
    { operation: 'create', path: '.npmrc', symbols: ['registry'], instructions: 'Registry line only, never a token.', evidence: ['package.json:1'] },
  )
  expect(validatePlan(plan, spec, files, tracked)).toEqual([])
  expect(validatePlan(plan, spec, files)).toContain('Missing modify target: pnpm-lock.yaml')
  for (const path of ['.env', 'config/credentials.json', 'id_rsa', 'node_modules/pkg/pnpm-lock.yaml', 'dist/.npmrc']) {
    const unsafe = validPlan(); unsafe.tasks[1]!.changes[0]!.path = path
    expect(validatePlan(unsafe, spec, files, tracked)).toContain(`Unsafe path: ${path}`)
  }
  const directory = validPlan(); directory.tasks[1]!.changes[0]!.path = 'src'
  expect(validatePlan(directory, spec, files, tracked)).toContain('Target is a directory, not a file; name each file to modify: src')
})

it('keeps support files out of a tests task: the plan lists test files and the implementer creates their fixtures and helpers', () => {
  for (const [operation, path] of [['create', 'packages/format/fixtures/agent.yaml'], ['create', 'src/fixture-helper.ts'], ['create', 'packages/cli/package.json'], ['modify', 'package.json']] as const) {
    const plan = validPlan()
    plan.tasks[0]!.changes.push({ operation, path, symbols: ['support'], instructions: 'Support the cases.', evidence: ['tests/example.test.ts:1'] })
    expect(validatePlan(plan, spec, files)).toContain(`Test task changes a non-test target: P1/${path}`)
  }
})

it('treats a plan as UI work only when it writes UI files', () => {
  expect(touchesUi(validPlan())).toBe(false)
  const ui = validPlan(); ui.tasks[1]!.changes[0]!.path = 'app/items/page.tsx'
  expect(touchesUi(ui)).toBe(true)
})

it('accepts a handoff for work a named person does: no file changes, and its criterion needs no code or test', () => {
  const specWithPage = spec + '- [ ] F2: A format reference page exists in Notion.\n'
  const plan = validPlan()
  plan.tasks.splice(2, 0, { id: 'P4', title: 'Publish the Notion page', kind: 'handoff', featureIds: ['F2'], dependsOn: [], testIds: [], changes: [], commands: [], outcome: 'David confirms the page is linked from the Overview.' })
  expect(validatePlan(plan, specWithPage, files).filter((error) => /F2|P4/.test(error))).toEqual([])
  plan.tasks[2]!.changes.push({ operation: 'create', path: 'docs/page.md', symbols: ['page'], instructions: 'x', evidence: ['src/items.ts:1'] })
  expect(validatePlan(plan, specWithPage, files)).toContain('A handoff changes no files; the person makes the change: P4')
})

const retention = { question: 'Keep saved items forever?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'nothing else expires', whyYours: 'storage cost' }

describe('decisions', () => {
  it('requires every decision to carry options, a recommended option among them and why it is the author\'s', () => {
    expect(decisionSchema.safeParse(retention).success).toBe(true)
    expect(researchSchema.safeParse({ facts: [], checks: [], gaps: [], decisions: ['Choose retention'] }).success).toBe(false)
    expect(researchSchema.safeParse({ facts: [], checks: [], gaps: [], decisions: [retention] }).success).toBe(true)
    expect(planSchema.safeParse({ ...validPlan(), decisions: [{ ...retention, options: ['Keep forever'] }] }).success).toBe(false)
    expect(planSchema.safeParse({ ...validPlan(), decisions: [{ ...retention, recommended: 'Never' }] }).success).toBe(false)
    expect(planSchema.safeParse({ ...validPlan(), decisions: [{ ...retention, whyYours: '' }] }).success).toBe(false)
  })

  it('merges research and planning decisions by question, numbers them, and applies the author\'s ticked answers', () => {
    const merged = mergeDecisions([[retention], [{ ...retention, question: 'Keep saved items forever' }, { ...retention, question: 'Which list is mine?' }]])
    expect(merged.map((d) => [d.id, d.question, d.decidedBy])).toEqual([['D1', 'Keep saved items forever?', 'open'], ['D2', 'Which list is mine?', 'open']])
    const answered = mergeDecisions([[retention]], [{ id: 'D1', question: 'Keep saved items forever?', answer: 'Expire after 30 days' }])
    expect(answered[0]).toMatchObject({ decidedBy: 'author', answer: 'Expire after 30 days' })
  })

  it('renders each decision in the plan with a checkbox per option, recommended first, and the count of open ones', () => {
    const plan = validPlan()
    const text = renderPlan(plan, 'needs-author', { specPath: '/spec.md', commit: 'abc', dirty: false }, [], mergeDecisions([[{ ...retention, options: ['Expire after 30 days', 'Keep forever'] }]]))
    expect(text).toContain('1 decision: 1 open · 0 answered')
    expect(text).toContain('### D1 — Keep saved items forever?\n\n- [ ] Keep forever _(recommended: nothing else expires)_\n- [ ] Expire after 30 days\n\nWhy it is yours to decide: storage cost')
  })
})

describe('checks', () => {
  it('orders the readiness problems critical, high, medium with a header count equal to the list', () => {
    const problems = ['Uncovered guideline: TEST-001', 'Missing modify target: src/x.ts', 'planning: provider down', 'Research gap: did not read src/y.ts', 'No structured plan produced']
    expect(problems.map(problemSeverity)).toEqual(['medium', 'high', 'critical', 'medium', 'critical'])
    const text = renderChecks('incomplete', problems)
    expect(text).toContain('5 problems: 2 critical · 1 high · 2 medium · 0 low · 0 info')
    expect(text.indexOf('## Critical')).toBeLessThan(text.indexOf('## High'))
    expect(text.indexOf('## High')).toBeLessThan(text.indexOf('## Medium'))
    expect(text.indexOf('- planning: provider down')).toBeLessThan(text.indexOf('- No structured plan produced'))
    expect(text.match(/^- /gm)).toHaveLength(5)
    expect(renderChecks('ready', [])).toContain('0 problems: 0 critical · 0 high · 0 medium · 0 low · 0 info')
    const plan = renderPlan(validPlan(), 'incomplete', { specPath: '/spec.md', commit: 'abc', dirty: false }, problems)
    expect(plan.indexOf('- **critical** · planning: provider down')).toBeLessThan(plan.indexOf('- **medium** · Uncovered guideline: TEST-001'))
  })
})
