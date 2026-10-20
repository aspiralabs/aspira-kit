// KIT-39: after the build, the analyzer runs once per app directory the implementor changed, each
// with its own --app, and is done only when every one of them ended ready; with no record of changed
// apps, aspira.json's app alone, as before.
import { describe, expect, it } from 'vitest'
import { analyzerApps, routeStatus, type RouteFacts } from '#src/route.ts'
import { emptyRunState, type RunState } from '#src/run-state.ts'
import { analyzedApps, analyzerStepApps, commandApp } from '#src/step-results.ts'

const facts: RouteFacts = { id: 'KIT-11', app: 'tools/aspira', specCovered: true, implementor: 'ready', analyzerReady: false, mode: 'local' }
const step = (name: string, command: string, status: string): RunState['steps'][number] => ({ step: name, runId: 'run-1', command, status, startedAt: 'now', endedAt: 'now', usage: null })

describe('analyzerApps', () => {
  it('is the apps the build changed, else aspira.json\'s app', () => {
    expect(analyzerApps({ app: 'tools/aspira', apps: ['instances/core/stack', 'instances/core/app'] })).toEqual(['instances/core/stack', 'instances/core/app'])
    expect(analyzerApps({ app: 'tools/aspira', apps: [] })).toEqual(['tools/aspira'])
    expect(analyzerApps({ app: '.' })).toEqual(['.'])
  })
})

describe('routeStatus after the build', () => {
  it('prints one analyzer step per changed app, each done on its own ready run', () => {
    const route = routeStatus('In Progress: Implementation', { ...facts, apps: ['instances/core/stack', 'instances/core/app'], analyzed: ['instances/core/stack'] })
    if (route.kind !== 'sequence') throw new Error(route.kind)
    const steps = route.items.flatMap((item) => (item.kind === 'step' ? [{ command: item.command, done: item.done }] : []))
    expect(steps).toEqual([
      { command: '/aspira-code-analyzer KIT-11 --app instances/core/stack --local', done: true },
      { command: '/aspira-code-analyzer KIT-11 --app instances/core/app --local', done: false },
    ])
  })

  it('falls back to the one aspira.json app with the old readiness when the build names no app', () => {
    const route = routeStatus('In Progress: Implementation', { ...facts, analyzerReady: true })
    if (route.kind !== 'sequence') throw new Error(route.kind)
    expect(route.items.flatMap((item) => (item.kind === 'step' ? [{ command: item.command, done: item.done }] : []))).toEqual([{ command: '/aspira-code-analyzer KIT-11 --app tools/aspira --local', done: true }])
  })
})

describe('analyzedApps', () => {
  it('counts a ready analyzer run per --app since the last build, and nothing from before it', () => {
    const state: RunState = {
      ...emptyRunState(),
      steps: [
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app instances/core/app --local', 'ready'),
        step('implementor', '/aspira-implementor KIT-11 --local', 'ready'),
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app instances/core/stack --local', 'ready'),
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app tools/aspira --local', 'incomplete'),
      ],
    }
    expect(analyzedApps(state, ['instances/core/stack', 'instances/core/app', 'tools/aspira'])).toEqual(['instances/core/stack'])
  })
})

describe('analyzerStepApps and commandApp (KIT-40)', () => {
  it('lists the apps of the analyzer steps since the last build, or the fallback when there were none', () => {
    const state: RunState = {
      ...emptyRunState(),
      steps: [
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app old/app --local', 'ready'),
        step('implementor', '/aspira-implementor KIT-11 --local', 'ready'),
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app . --local', 'ready'),
        step('code-analyzer', '/aspira-code-analyzer KIT-11 --app pkgs/a/ --local', 'ready'),
      ],
    }
    expect(analyzerStepApps(state, 'tools/aspira')).toEqual(['.', 'pkgs/a'])
    expect(analyzerStepApps(emptyRunState(), 'tools/aspira')).toEqual(['tools/aspira'])
    expect(commandApp('/aspira-code-analyzer KIT-11 --local', 'tools/aspira')).toBe('tools/aspira')
  })
})
