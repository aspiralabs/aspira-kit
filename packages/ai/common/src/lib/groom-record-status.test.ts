// T9 (plan.json P1, P14; F3, F7): the groomer's run record on the five new statuses.
// `rebuildGroomRecord` ignores the Stop to-do today (groom-record.ts:152: status comes from
// Confirm alone) and `groomRecordSchema` strips `reason`/`reasonCode` as unknown keys today
// (groom-record.ts:86-99 is a strict object without them), so this is expected to fail until P14
// adds them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rebuildGroomRecord, readGroomRecord, writeGroomRecord, type GroomRecord } from './groom-record.ts'

/** A page with a `## STOP — Stop grooming` region; `checked` controls the to-do's tick. */
const stopPage = (checked: boolean): string => ['# Grooming Decisions', '', '## STOP — Stop grooming', '', `- [${checked ? 'x' : ' '}] Stop grooming`, ''].join('\n')

/** A page with a `## CONFIRM — Grooming is complete` region; `checked` controls the Confirm tick. */
const confirmPage = (checked: boolean): string => ['# Grooming Decisions', '', '## CONFIRM — Grooming is complete', '', `- [${checked ? 'x' : ' '}] Confirm`, ...(checked ? ['Confirmed 2026-10-14'] : []), ''].join('\n')

describe('rebuildGroomRecord on the Stop and Confirm to-dos (T9, F3)', () => {
  it('a page with Stop ticked rebuilds as needs-author with reasonCode paused', () => {
    const { record } = rebuildGroomRecord(stopPage(true))
    expect(record.status).toBe('needs-author')
    expect((record as GroomRecord & { reasonCode: string | null }).reasonCode).toBe('paused')
  })

  it('a page with Confirm ticked rebuilds as ready', () => {
    const { record } = rebuildGroomRecord(confirmPage(true))
    expect(record.status).toBe('ready')
  })

  it('a page with neither ticked rebuilds as needs-author with no reasonCode', () => {
    const { record } = rebuildGroomRecord(stopPage(false))
    expect(record.status).toBe('needs-author')
    expect((record as GroomRecord & { reasonCode: string | null }).reasonCode).toBeNull()
  })
})

describe('groom.json reason and reasonCode (T9, F3)', () => {
  let folder: string
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'groom-record-status-'))
  })
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  const baseRecord = (status: string, reason: string | null, reasonCode: string | null): GroomRecord =>
    ({
      decisions: [],
      branches: [],
      round: 1,
      startedAt: '2026-10-14T00:00:00.000Z',
      open: 0,
      page: {},
      status,
      reason,
      reasonCode,
    }) as unknown as GroomRecord

  it('reason and reasonCode survive a write and a read', async () => {
    await writeGroomRecord(folder, baseRecord('needs-author', 'Stop was ticked by the author.', 'paused'))
    const read = await readGroomRecord(folder)
    expect(read?.status).toBe('needs-author')
    expect((read as unknown as { reason: string | null }).reason).toBe('Stop was ticked by the author.')
    expect((read as unknown as { reasonCode: string | null }).reasonCode).toBe('paused')
  })

  it('an old groom.json with status stopped reads as needs-author with reasonCode paused', async () => {
    await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
    await writeFile(join(folder, 'groom', 'trace', 'groom.json'), JSON.stringify({ decisions: [], branches: [], round: 1, startedAt: '2026-10-01T00:00:00.000Z', open: 0, page: {}, status: 'stopped' }))
    const read = await readGroomRecord(folder)
    expect(read?.status).toBe('needs-author')
    expect((read as unknown as { reasonCode: string | null }).reasonCode).toBe('paused')
  })

  it('an old groom.json with status confirmed reads as ready', async () => {
    await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
    await writeFile(join(folder, 'groom', 'trace', 'groom.json'), JSON.stringify({ decisions: [], branches: [], round: 1, startedAt: '2026-10-01T00:00:00.000Z', open: 0, page: {}, status: 'confirmed' }))
    const read = await readGroomRecord(folder)
    expect(read?.status).toBe('ready')
  })
})
