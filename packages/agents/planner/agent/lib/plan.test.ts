import { expect, it } from 'vitest'
import { renderPlan, validatePlan } from './plan.ts'
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
