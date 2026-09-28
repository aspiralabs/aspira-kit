import { describe, expect, it } from 'vitest'
import type { Analyzer } from './analyzers.ts'
import type { Executor, RunResult } from './executor.ts'
import { runLoop, type Fixer } from './loop.ts'
import { tsc } from './parsers.ts'

/** A scripted executor: `state.errors` is what the "analyzer" reports; commands are recorded. */
function scripted(state: { errors: string[] }) {
  const commands: string[] = []
  const ok = (stdout = ''): RunResult => ({ exitCode: stdout ? 1 : 0, stdout, stderr: '', timedOut: false })
  const executor: Executor = {
    kind: 'host', root: '/repo', canInstall: false,
    async run(command) {
      commands.push(command)
      if (command === 'check') return ok(state.errors.map((e, i) => `src/${e}.ts(${i + 1},1): error TS1: bad ${e}`).join('\n'))
      if (command === 'crash') return { exitCode: 2, stdout: '', stderr: 'boom', timedOut: false }
      return ok()
    },
    readFile: async () => null, writeFile: async () => {}, exists: async () => false, listFiles: async () => [],
  }
  return { executor, commands }
}
const analyzer = (id: string, check: string, fix: string | null = null): Analyzer => ({ id, tool: 'tsc', ecosystem: 'js', cwd: '', check, fix, parse: tsc, requires: null, install: [] })
const options = (over: Partial<Parameters<typeof runLoop>[3]> = {}) => ({ maxRounds: 4, maxCostUsd: 5, costSoFar: () => 0, fixWarnings: false, commandTimeoutMs: 1000, concurrency: 2, ...over })

describe('runLoop', () => {
  it('stops clean after the fixer clears everything, recording rounds', async () => {
    const state = { errors: ['a', 'b'] }
    const { executor } = scripted(state)
    const fixer: Fixer = async ({ batch }) => { state.errors = state.errors.filter((e) => !batch.files.includes(`src/${e}.ts`)); return { edits: batch.files.length, editedFiles: batch.files, rejected: [], unresolved: [] } }
    const result = await runLoop(executor, [analyzer('tsc', 'check')], fixer, options())
    expect(result.status).toBe('clean')
    expect(result.reason).toBe('analyzers clean')
    expect(result.rounds.map((r) => [r.targets, r.edits])).toEqual([[2, 2], [0, 0]])
    expect(result.editedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.initial).toHaveLength(2)
    expect(result.remaining).toEqual([])
  })
  it('never calls the fixer when autofix alone clears the errors', async () => {
    const state = { errors: ['fmt'] }
    const { executor, commands } = scripted(state)
    executor.run = new Proxy(executor.run, { apply: (target, self, args: [string]) => { if (args[0] === 'fix') state.errors = []; return Reflect.apply(target, self, args) } })
    let called = 0
    const result = await runLoop(executor, [analyzer('tsc', 'check', 'fix')], async () => { called++; return { edits: 0, editedFiles: [], rejected: [], unresolved: [] } }, options())
    expect(called).toBe(0)
    expect(result.status).toBe('clean')
    expect(result.rounds[0]!.autofix).toEqual([expect.objectContaining({ id: 'tsc', exitCode: 0 })])
    expect(commands.filter((c) => c === 'check')).toHaveLength(2)
  })
  it('stops on an unchanged set, on the round cap and on the cost cap', async () => {
    const stuck = { errors: ['x'] }
    const noop: Fixer = async () => ({ edits: 0, editedFiles: [], rejected: [{ path: 'src/x.ts', reason: 'protected path' }], unresolved: ['src/x.ts:1 needs a decision'] })
    const stalled = await runLoop(scripted(stuck).executor, [analyzer('tsc', 'check')], noop, options())
    expect(stalled.status).toBe('partial')
    expect(stalled.reason).toContain('no progress')
    expect(stalled.rounds).toHaveLength(2)
    expect(stalled.rejected).toHaveLength(1)
    const shrinking = { errors: ['a', 'b', 'c', 'd', 'e'] }
    const oneAtATime: Fixer = async () => { shrinking.errors.pop(); return { edits: 1, editedFiles: [], rejected: [], unresolved: [] } }
    const capped = await runLoop(scripted(shrinking).executor, [analyzer('tsc', 'check')], oneAtATime, options({ maxRounds: 2 }))
    expect(capped.reason).toBe('round cap (2) reached')
    expect(capped.remaining).toHaveLength(3)
    let cost = 0
    const costly = await runLoop(scripted({ errors: ['a', 'b', 'c'] }).executor, [analyzer('tsc', 'check')], async () => { cost += 3; return { edits: 0, editedFiles: [], rejected: [], unresolved: [] } }, options({ maxCostUsd: 2, costSoFar: () => cost }))
    expect(costly.reason).toBe('cost cap ($2) reached')
    expect(costly.rounds).toHaveLength(1)
  })
  it('records analyzer problems and never reports clean while one could not run', async () => {
    const { executor } = scripted({ errors: [] })
    const result = await runLoop(executor, [analyzer('tsc', 'check'), analyzer('broken', 'crash')], async () => ({ edits: 0, editedFiles: [], rejected: [], unresolved: [] }), options())
    expect(result.status).toBe('partial')
    expect(result.problems[0]).toContain('broken: exit 2 with no diagnostics')
    const dead = await runLoop(executor, [analyzer('broken', 'crash')], async () => ({ edits: 0, editedFiles: [], rejected: [], unresolved: [] }), options())
    expect(dead.status).toBe('failed')
    expect((await runLoop(executor, [], async () => ({ edits: 0, editedFiles: [], rejected: [], unresolved: [] }), options())).status).toBe('nothing-detected')
  })
})
