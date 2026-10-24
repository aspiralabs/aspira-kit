import { describe, expect, it } from 'vitest'
import { black, cargoFmt, colonLines, eslintJson, eslintStylish, githubAnnotations, gofmt, mypy, prettier, pyright, rubocopJson, ruffFormat, ruffJson, script, tsc } from './parsers.ts'

const where = { cwd: 'packages/ui', root: '/repo' }

describe('parsers', () => {
  it('eslint json', () => {
    const out = eslintJson(`\n> lint\n${JSON.stringify([{ filePath: '/repo/packages/ui/src/a.ts', messages: [{ line: 3, column: 5, message: 'Unexpected any', ruleId: 'no-explicit-any', severity: 2 }, { line: 9, column: 1, message: 'meh', ruleId: 'x', severity: 1 }] }])}`, '', where)
    expect(out).toEqual([
      { tool: 'eslint', file: 'packages/ui/src/a.ts', line: 3, column: 5, message: 'Unexpected any', rule: 'no-explicit-any', severity: 'error' },
      { tool: 'eslint', file: 'packages/ui/src/a.ts', line: 9, column: 1, message: 'meh', rule: 'x', severity: 'warning' },
    ])
    expect(eslintJson('Oops something crashed', '', where)).toBeNull()
  })
  it('eslint stylish and tsc', () => {
    const stylish = eslintStylish('\n/repo/packages/ui/src/b.tsx\n  12:3  error  No ternaries in JSX  aspira/no-jsx-ternary\n  14:1  warning  Unused  no-unused-vars\n\n✖ 2 problems (1 error, 1 warning)\n', '', where)
    expect(stylish).toHaveLength(2)
    expect(stylish![0]).toMatchObject({ file: 'packages/ui/src/b.tsx', line: 12, rule: 'aspira/no-jsx-ternary', severity: 'error' })
    const types = tsc('src/c.ts(4,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n  Continued detail.\n', '', where)
    expect(types).toEqual([{ tool: 'tsc', file: 'packages/ui/src/c.ts', line: 4, column: 7, message: "Type 'string' is not assignable to type 'number'. Continued detail.", rule: 'TS2322', severity: 'error' }])
  })
  it('prettier, biome annotations, ruff, black, gofmt, cargo fmt', () => {
    expect(prettier('Checking formatting...\n[warn] src/d.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.', '', where)).toEqual([expect.objectContaining({ tool: 'prettier', file: 'packages/ui/src/d.ts', severity: 'error' })])
    expect(githubAnnotations('biome')('::error title=lint/suspicious/noExplicitAny,file=src/e.ts,line=2,endLine=2,col=9,endColumn=12::Unexpected any%0AUse unknown', '', where)).toEqual([{ tool: 'biome', file: 'packages/ui/src/e.ts', line: 2, column: 9, message: 'Unexpected any\nUse unknown', rule: 'lint/suspicious/noExplicitAny', severity: 'error' }])
    expect(ruffJson(JSON.stringify([{ code: 'F401', message: 'os imported but unused', filename: '/repo/packages/ui/x.py', location: { row: 1, column: 8 } }]), '', where)).toEqual([{ tool: 'ruff', file: 'packages/ui/x.py', line: 1, column: 8, message: 'os imported but unused', rule: 'F401', severity: 'error' }])
    expect(ruffFormat('Would reformat: x.py\n1 file would be reformatted', '', where)![0]!.file).toBe('packages/ui/x.py')
    expect(black('', 'would reformat y.py\nOh no!', where)![0]!.file).toBe('packages/ui/y.py')
    expect(gofmt('main.go\npkg/a.go\n', '', { cwd: '', root: '/repo' })!.map((d) => d.file)).toEqual(['main.go', 'pkg/a.go'])
    expect(cargoFmt('Diff in /repo/src/lib.rs at line 3:\n-a\n+b', '', { cwd: '', root: '/repo' })).toEqual([expect.objectContaining({ tool: 'cargo-fmt', file: 'src/lib.rs' })])
  })
  it('mypy, pyright, rubocop and colon-separated lines', () => {
    expect(mypy('app/m.py:10:5: error: Incompatible return value type  [return-value]\napp/m.py:12: note: See docs\nFound 1 error', '', { cwd: '', root: '/repo' })).toEqual([{ tool: 'mypy', file: 'app/m.py', line: 10, column: 5, message: 'Incompatible return value type', rule: 'return-value', severity: 'error' }])
    expect(pyright(JSON.stringify({ generalDiagnostics: [{ file: '/repo/p.py', severity: 'error', message: 'bad', rule: 'reportGeneralTypeIssues', range: { start: { line: 0, character: 4 } } }] }), '', { cwd: '', root: '/repo' })).toEqual([{ tool: 'pyright', file: 'p.py', line: 1, column: 5, message: 'bad', rule: 'reportGeneralTypeIssues', severity: 'error' }])
    expect(rubocopJson(JSON.stringify({ files: [{ path: 'app/r.rb', offenses: [{ severity: 'convention', message: 'Style', cop_name: 'Style/StringLiterals', location: { start_line: 2, start_column: 1 } }] }] }), '', { cwd: '', root: '/repo' })).toEqual([{ tool: 'rubocop', file: 'app/r.rb', line: 2, column: 1, message: 'Style', rule: 'Style/StringLiterals', severity: 'error' }])
    expect(colonLines('go-vet')('', '# example.com/m\n./main.go:7:2: unreachable code\nvet: pkg/a.go:3:1: undefined: x', { cwd: '', root: '/repo' })).toEqual([
      expect.objectContaining({ tool: 'go-vet', file: 'main.go', line: 7, column: 2, message: 'unreachable code' }),
      expect.objectContaining({ file: 'pkg/a.go', line: 3, message: 'undefined: x' }),
    ])
    expect(colonLines('clippy')('', 'src/main.rs:4:5: warning: unused variable: `x`\nerror: could not compile\nwarning: 1 warning emitted', { cwd: '', root: '/repo' })).toEqual([expect.objectContaining({ tool: 'clippy', file: 'src/main.rs', line: 4, severity: 'warning', message: 'unused variable: `x`' })])
    expect(colonLines('flake8')('a.py:1:1: E302 expected 2 blank lines', '', { cwd: '', root: '/repo' })).toEqual([expect.objectContaining({ rule: 'E302', message: 'expected 2 blank lines' })])
  })
  it('script output combines formats and unparseable output stays empty', () => {
    const out = script('lint')('> turbo lint\npackages/a/src/x.ts(1,1): error TS1000: nope\n/repo/packages/a/src/y.ts\n  1:1  error  bad  rule\n', '', { cwd: '', root: '/repo' })
    expect(out!.map((d) => d.tool).sort()).toEqual(['eslint', 'tsc'])
    expect(script('lint')('garbage that is not a diagnostic', '', { cwd: '', root: '/repo' })).toEqual([])
  })
})
