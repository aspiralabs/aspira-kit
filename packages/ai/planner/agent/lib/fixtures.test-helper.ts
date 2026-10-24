import type { Plan } from './plan.ts'

export const spec = '# Feature\n## Intent\nPersist a named item.\n## Acceptance criteria\n### Features\n- [ ] F1: An authorized user can save an item once.\n'
export const files = new Map([['src/items.ts', 'export function save() {}\n'], ['tests/example.test.ts', 'test("existing convention", () => {})\n'], ['package.json', '{"scripts":{"test":"vitest run"}}']])
export function validPlan(): Plan {
  return {
    summary: 'Persist a named item idempotently.',
    tasks: [
      { id: 'P1', title: 'Write failing tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1', 'T2'], changes: [{ operation: 'create', path: 'tests/items.test.ts', symbols: ['save cases'], instructions: 'Add cases using the existing test runner and data fixtures.', evidence: ['tests/example.test.ts:1'] }], commands: ['pnpm test tests/items.test.ts'], outcome: 'Both cases fail for the missing behavior.' },
      { id: 'P2', title: 'Implement saving', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1', 'T2'], changes: [{ operation: 'modify', path: 'src/items.ts', symbols: ['save'], instructions: 'Validate ownership and persist by unique item key; return the existing record on retry.', evidence: ['src/items.ts:1'] }], commands: [], outcome: 'Both test cases pass.' },
      { id: 'P3', title: 'Verify business acceptance', kind: 'verification', featureIds: ['F1'], dependsOn: ['P2'], testIds: ['T1', 'T2'], changes: [], commands: ['pnpm test'], outcome: 'Authorized saves persist once and all existing tests pass.' },
    ],
    tests: [
      { id: 'T1', kind: 'unit', path: 'tests/items.test.ts', featureIds: ['F1'], setup: 'Stub item persistence.', action: 'Save the same owned key twice.', assertions: ['Only one create occurs.'] },
      { id: 'T2', kind: 'integration', path: 'tests/items.test.ts', featureIds: ['F1'], setup: 'Use the test database and an authenticated user.', action: 'Save through the public entry point and reload.', assertions: ['The persisted item belongs to the user.'] },
    ],
    checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1 and tests/example.test.ts:1 establish existing conventions.' }], decisions: [], gaps: [],
  }
}
