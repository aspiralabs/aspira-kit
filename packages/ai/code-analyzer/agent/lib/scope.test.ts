// KIT-48: a ticket run fixes only the files the ticket branch changed; diagnostics in untouched
// files are reported as pre-existing and never fixed or counted against readiness.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Analyzer } from './analyzers.ts'
import type { Executor, RunResult } from './executor.ts'
import { runAutofix, runLoop } from './loop.ts'
import { tsc } from './parsers.ts'
import { changedScope, filesFor, partition, scopeNote } from './scope.ts'

/** A scripted executor over a repository at /repo with the app at /repo/apps/web. */
function scripted(state: { errors: string[]; git?: Record<string, RunResult> }) {
  const commands: string[] = []
  const ok = (stdout = '', exitCode = stdout ? 1 : 0): RunResult => ({ exitCode, stdout, stderr: '', timedOut: false })
  const executor: Executor = {
    kind: 'host', root: '/repo/apps/web', canInstall: false,
    async run(command) {
      commands.push(command)
      if (state.git?.[command]) return state.git[command]!
      if (command.startsWith('git rev-parse --verify -q origin/main')) return ok('abc', 0)
      if (command.startsWith('git merge-base')) return ok('base0', 0)
      if (command.startsWith('git diff --name-only')) return ok('apps/web/src/a.ts\napps/web/src/b.py\napps/mobile/src/c.ts\n', 0)
      if (command.startsWith('git status --porcelain')) return ok(' M apps/web/src/d.ts\n?? apps/web/src/e.ts\n D apps/web/src/gone.ts\nR  apps/web/old.ts -> apps/web/src/new.ts\n', 0)
      if (command === 'check') return ok(state.errors.map((e, i) => `src/${e}.ts(${i + 1},1): error TS1: bad ${e}`).join('\n'))
      return ok()
    },
    readFile: async () => null, writeFile: async () => {}, exists: async () => false, listFiles: async () => [],
  }
  return { executor, commands }
}

describe('changedScope', () => {
  it('lists the branch diff and the working tree changes under the app, app-relative, without deletions', async () => {
    const { executor } = scripted({ errors: [] })
    const { scope, note } = await changedScope(executor, '/repo')
    expect(note).toBeNull()
    expect(scope).toEqual({ base: 'origin/main', files: ['src/a.ts', 'src/b.py', 'src/d.ts', 'src/e.ts', 'src/new.ts'] })
  })
  it('keeps the whole tree, with a note, when there is no main branch', async () => {
    const fail: RunResult = { exitCode: 128, stdout: '', stderr: '', timedOut: false }
    const { executor } = scripted({ errors: [], git: { 'git rev-parse --verify -q origin/main': fail, 'git rev-parse --verify -q main': fail } })
    const { scope, note } = await changedScope(executor, '/repo')
    expect(scope).toBeNull()
    expect(note).toContain('no main branch')
  })
  it('AVA1.1 never puts a baseBranch that is not a plain branch name into a command; it diffs against main', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'scope-base-')))
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, 'aspira.json'), JSON.stringify({ baseBranch: 'main;id' }))
    const { executor, commands } = scripted({ errors: [] })
    const { scope } = await changedScope({ ...executor, root: repo }, repo)
    expect(commands.filter((c) => c.includes(';id'))).toEqual([])
    expect(scope?.base).toBe('origin/main')
  })
})

describe('partition and filesFor', () => {
  const scope = { base: 'origin/main', files: ['src/a.ts', 'src/b.py', 'lib/c.ts'] }
  it('splits diagnostics by scope and selects the files an analyzer handles under its cwd', () => {
    const diag = (file: string) => ({ tool: 'tsc', file, line: 1, column: 1, message: 'm', rule: null, severity: 'error' as const })
    expect(partition([diag('src/a.ts'), diag('src/z.ts')], scope)).toEqual({ targets: [diag('src/a.ts')], untouched: [diag('src/z.ts')] })
    expect(partition([diag('src/z.ts')], null)).toEqual({ targets: [diag('src/z.ts')], untouched: [] })
    expect(filesFor(scope, '', /\.ts$/)).toEqual(['src/a.ts', 'lib/c.ts'])
    expect(filesFor(scope, 'src', /\.(ts|py)$/)).toEqual(['a.ts', 'b.py'])
    expect(scopeNote(scope, [diag('src/z.ts'), diag('src/z.ts')])).toBe('Scope: the 3 files the ticket branch changed against origin/main; 2 pre-existing diagnostics in 1 untouched file left as they are')
  })
})

describe('scoped loop', () => {
  const analyzer = (over: Partial<Analyzer> = {}): Analyzer => ({ id: 'tsc', tool: 'tsc', ecosystem: 'js', cwd: '', check: 'check', fix: 'fix-all', parse: tsc, requires: null, install: [], ...over })
  const options = (over: Record<string, unknown> = {}) => ({ maxRounds: 2, maxCostUsd: 5, costSoFar: () => 0, fixWarnings: false, commandTimeoutMs: 1000, concurrency: 2, ...over })

  it('runs the per-file fix on the scope files the tool handles, and skips a tool whose fix takes no files', async () => {
    const { executor, commands } = scripted({ errors: [] })
    const scope = { base: 'origin/main', files: ['src/a.ts', 'src/b.py', 'README.md'] }
    const fixable = analyzer({ id: 'eslint', fixFiles: (files) => `fix-files ${files.join(' ')}`, exts: /\.ts$/ })
    const whole = analyzer({ id: 'script:format', fix: 'pnpm run format' })
    const none = analyzer({ id: 'ruff', fixFiles: (files) => `ruff ${files.join(' ')}`, exts: /\.go$/ })
    await runAutofix(executor, [fixable, whole, none], { ...options(), scope })
    expect(commands.filter((c) => !c.startsWith('git'))).toEqual(['fix-files src/a.ts'])
  })

  it('ends ready with the untouched diagnostics reported, never fixed, when only pre-existing errors remain', async () => {
    const state = { errors: ['a', 'old'] }
    const { executor } = scripted(state)
    const scope = { base: 'origin/main', files: ['src/a.ts'] }
    const batches: string[][] = []
    const result = await runLoop(executor, [analyzer({ fix: null })], async ({ batch }) => { batches.push(batch.files); state.errors = state.errors.filter((e) => e !== 'a'); return { edits: 1, editedFiles: batch.files, rejected: [], unresolved: [] } }, options({ scope }))
    expect(batches).toEqual([['src/a.ts']])
    expect(result.status).toBe('ready')
    expect(result.remaining).toEqual([])
    expect(result.untouched?.map((d) => d.file)).toEqual(['src/old.ts'])
    expect(result.scope).toEqual(scope)
  })
})
