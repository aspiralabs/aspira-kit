import { describe, expect, it } from 'vitest'
import { applyGuardedEdit, isProtected, suppressionCount } from './guards.ts'

const root = '/repo'
describe('guards', () => {
  it('rejects suppressions, protected paths, tests, escapes, bad anchors and emptied files', () => {
    const code = 'const a = 1\nexport const b: any = a\n'
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'export const b: any = a', after: '// eslint-disable-next-line\nexport const b: any = a' }, code)).toEqual({ reason: 'edit adds a suppression directive; fix the code instead' })
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'const a = 1', after: 'const a = 1 // @ts-ignore' }, code)).toHaveProperty('reason')
    for (const path of ['eslint.config.mjs', 'packages/ui/tsconfig.json', 'pyproject.toml', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'biome.json', '.rubocop.yml', 'AGENTS.md']) expect(isProtected(path), path).toContain('analyzer configuration')
    for (const path of ['src/a.test.ts', 'tests/x.py', 'pkg/a_test.go', 'spec/a_spec.rb', '__tests__/b.tsx']) expect(isProtected(path), path).toBe('test file')
    expect(isProtected('src/components/button.tsx')).toBeNull()
    expect(applyGuardedEdit(root, { path: '../outside.ts', before: 'x', after: 'y' }, 'x')).toEqual({ reason: 'path is outside the repository' })
    expect(applyGuardedEdit(root, { path: 'src/new.ts', before: 'x', after: 'y' }, null)).toHaveProperty('reason', expect.stringContaining('does not exist'))
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'nope', after: 'y' }, code)).toHaveProperty('reason', expect.stringContaining('not found'))
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'a', after: 'y' }, code)).toHaveProperty('reason', expect.stringContaining('ambiguous'))
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: code.trim(), after: '' }, code)).toEqual({ reason: 'edit would empty the file' })
    const long = `${'line\n'.repeat(60)}tail`
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'line\n'.repeat(60), after: '' }, long)).toHaveProperty('reason', expect.stringContaining('removes most'))
  })
  it('accepts a plain code fix and keeps existing suppressions neutral', () => {
    const code = '// eslint-disable-next-line no-console\nconsole.log(1)\nexport const b: any = 2\n'
    expect(suppressionCount(code)).toBe(1)
    expect(applyGuardedEdit(root, { path: 'src/a.ts', before: 'export const b: any = 2', after: 'export const b: number = 2' }, code)).toEqual({ content: '// eslint-disable-next-line no-console\nconsole.log(1)\nexport const b: number = 2\n' })
  })
})
