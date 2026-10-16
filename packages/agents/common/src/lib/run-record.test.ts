// T5 (plan.json P1, F6): readRunRecord, part of the run-status module added by P14
// (packages/agents/common/src/lib/run-status.ts). F6: "A run refused at a board gate reports
// refused, and a run stopped at the knowledge stage for a missing prerequisite reports blocked,
// from the driver's own outcome, whether or not an agent trace exists. Any other run whose trace
// file is missing or unreadable, or whose trace records a word outside both the new statuses and
// the old words F7 maps, is reported as incomplete and exits non-zero."
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRunRecord } from './run-status.ts'

describe('readRunRecord (T5, F6)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'run-record-'))
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('a missing trace with no driver outcome reads incomplete, naming the missing file', async () => {
    const folder = join(repo, '.work', 'kit-2-x')
    await mkdir(folder, { recursive: true })
    const result = await readRunRecord('planner', { folder })
    expect(result.status).toBe('incomplete')
    expect(result.reason).not.toBeNull()
    expect(result.reason).toContain('plan.review/trace/review.json')
  })

  it('a trace word outside the new statuses and the old words (finished) reads incomplete', async () => {
    const folder = join(repo, '.work', 'kit-2-x')
    await mkdir(join(folder, 'spec.written', 'trace'), { recursive: true })
    await writeFile(join(folder, 'spec.written', 'trace', 'review.json'), JSON.stringify({ status: 'finished' }))
    const result = await readRunRecord('spec-writer', { folder })
    expect(result.status).toBe('incomplete')
  })

  it('a driver outcome of refused or blocked is reported as that status even though no trace exists', async () => {
    const folder = join(repo, '.work', 'kit-2-x-no-trace')
    await mkdir(folder, { recursive: true })
    const refused = await readRunRecord('planner', { folder }, { status: 'refused', reason: 'NOM-9 is "Idea"; planner needs "Ready: Spec".' })
    expect(refused.status).toBe('refused')
    const blocked = await readRunRecord('planner', { folder }, { status: 'blocked', reason: 'NOTION_TOKEN is not set.' })
    expect(blocked.status).toBe('blocked')
  })

  it('the code-analyzer clean record reads ready (old-word mapping) and the planner ready record reads ready', async () => {
    const app = 'apps/web'
    await mkdir(join(repo, app, '.static-analysis'), { recursive: true })
    await writeFile(join(repo, app, '.static-analysis', 'rounds.json'), JSON.stringify({ status: 'clean', ticket: 'KIT-2', head: 'abc123' }))
    const analyzer = await readRunRecord('code-analyzer', { folder: join(repo, '.work', 'kit-2-x'), repo, app })

    const plannerFolder = join(repo, '.work', 'kit-2-planner-ready')
    await mkdir(join(plannerFolder, 'plan.review', 'trace'), { recursive: true })
    await writeFile(join(plannerFolder, 'plan.review', 'trace', 'review.json'), JSON.stringify({ status: 'ready' }))
    const planner = await readRunRecord('planner', { folder: plannerFolder })

    expect(analyzer.status).toBe('ready')
    expect(planner.status).toBe('ready')
  })
})
