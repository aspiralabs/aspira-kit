// aspira.json `models` (model-config.ts): values and phase keys are validated, and a task's model and
// effort come from its `<step>.<phase>` entry or fall back to the kit default.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModelChoices, taskModel } from './model-config.ts'

async function repoWith(models: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'model-config-'))
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board', models }))
  await mkdir(join(repo, 'packages', 'app'), { recursive: true })
  return repo
}

describe('aspira.json models', () => {
  it('reads a bare model name and a { model, effort } object, for roles and phase keys alike', () => {
    expect(parseModelChoices({ planner: 'sonnet', 'planner.planning': { model: 'opus', effort: 'low' }, 'spec-writer.explore': { effort: 'medium' } })).toEqual({
      planner: { model: 'sonnet' },
      'planner.planning': { model: 'opus', effort: 'low' },
      'spec-writer.explore': { effort: 'medium' },
    })
  })

  it('refuses an unknown model, an unknown effort and a phase key of a step with no tasks, naming each', () => {
    const message = (() => {
      try {
        parseModelChoices({ planner: 'gpt', 'planner.research': { effort: 'none' }, 'gate.check': 'haiku' })
        return 'no refusal'
      } catch (error) {
        return String(error)
      }
    })()
    expect([message.includes('"planner": "gpt"'), message.includes('"planner.research"'), message.includes('unknown step "gate"')]).toEqual([true, true, true])
  })
})

describe('a task\'s model and effort', () => {
  it('takes its <step>.<phase> entry from the nearest aspira.json, also from a folder below the root', async () => {
    const repo = await repoWith({ 'planner.planning': { model: 'sonnet', effort: 'low' } })
    expect(taskModel('planner.planning', 'opus', join(repo, 'packages', 'app'))).toEqual({ model: 'sonnet', effort: 'low' })
  })

  it('keeps the default model, with no effort, for a phase the map leaves out or when there is no aspira.json', async () => {
    const repo = await repoWith({ 'planner.planning': 'sonnet' })
    const bare = await mkdtemp(join(tmpdir(), 'model-config-none-'))
    expect([taskModel('planner.research', 'opus', repo), taskModel('planner.planning', 'opus', bare)]).toEqual([{ model: 'opus' }, { model: 'opus' }])
  })

  it('keeps an effort-only entry on the default model', async () => {
    const repo = await repoWith({ 'implementor.worker': { effort: 'high' } })
    expect(taskModel('implementor.worker', 'sonnet', repo)).toEqual({ model: 'sonnet', effort: 'high' })
  })
})
