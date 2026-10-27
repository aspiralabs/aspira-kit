// KIT-68, F16: a confirmed grooming that still holds a blocking follow-up is not a finished groom stage (the run ends
// after grooming as needs-author listing it); one that holds only "build may go on" follow-ups is done, and the Build
// Summary lists those. Fixtures are real temp folders and literal run states.
//
// Contract these tests pin for the implementation:
//   routeRunState(folder, facts) (route.ts, see route-run-state.test.ts)
//     a blocking follow-up in groom.json keeps the stage at 'groom' and lists it in `needsAuthor` ({ id, question })
//   renderBuildSummary({ ..., groom? }) (summary.ts)
//     groom   the folder's GroomRecord, read by the driver; its build-may-go-on follow-ups are listed in the summary
//             on a line of their own with the question and "build may go on"; with none, the summary is unchanged
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GroomRecord } from '@aspiralabs/ai/common/lib/groom-record'
import { routeRunState } from '#build-feature/route.ts'
import { renderBuildSummary } from '#build-feature/summary.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const decision = (id: string, question: string, extra: Record<string, unknown>) => ({
  id,
  question,
  options: ['Option A', 'Option B'],
  recommended: 'Option A',
  reasoning: 'It matches the code',
  whyYours: 'It changes the product',
  branch: 'problem',
  facts: [],
  answer: null,
  ...extra,
})
const answered = decision('Q1', 'Who owns the list?', { decidedBy: 'author', answer: 'Option A' })
const blocking = decision('Q2', 'Do saved items expire?', { decidedBy: 'follow-up', followUp: 'blocks' })
const goingOn = decision('Q3', 'Which locale ships first?', { decidedBy: 'follow-up', followUp: 'may-go-on' })

/** A confirmed groom record. */
const confirmed = (...decisions: Record<string, unknown>[]) => ({ decisions, branches: [{ id: 'problem', state: 'visited' }], round: 2, startedAt: '2026-10-26T09:00:00.000Z', open: 0, page: { id: 'page-1', url: 'https://www.notion.so/page-1' }, status: 'ready', reasonCode: null, reason: null })

async function folderWith(record: unknown): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-follow-ups-')))
  temps.push(dir)
  const file = join(dir, 'groom', 'trace', 'groom.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(record))
  return dir
}

const facts = { id: 'NOM-4', app: '.' }

describe('the groom stage with follow-ups', () => {
  it('T31 is not done while a confirmed groom record holds a blocking follow-up, and lists it as needs-author', async () => {
    const routed = await routeRunState(await folderWith(confirmed(answered, blocking)), facts)
    expect([routed.stage, routed.needsAuthor?.map((item) => item.id), routed.needsAuthor?.[0]?.question]).toEqual(['groom', ['Q2'], 'Do saved items expire?'])
  })

  it('T31 is done when the confirmed record holds only a build-may-go-on follow-up', async () => {
    const routed = await routeRunState(await folderWith(confirmed(answered, goingOn)), facts)
    expect([routed.stage, routed.needsAuthor ?? []]).toEqual(['spec', []])
  })

  it('T31 resumes at the spec once the blocking follow-up is answered on the page', async () => {
    const resolved = decision('Q2', 'Do saved items expire?', { decidedBy: 'author', answer: 'Option A' })
    const routed = await routeRunState(await folderWith(confirmed(answered, resolved)), facts)
    expect(routed.stage).toBe('spec')
  })
})

describe('the Build Summary with follow-ups', () => {
  const ticket = { id: 'NOM-4', title: 'Explore pagination', url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1' }
  const RUN = 'run-20261026T090000Z'
  const state = {
    runs: [{ runId: RUN, command: '/aspira-build-feature NOM-4', startedAt: '2026-10-26T09:00:00.000Z', endedAt: '2026-10-26T12:00:00.000Z', ended: 'stopped', mode: 'local' as const, autonomous: false }],
    inProgress: null,
    approvals: [],
    moves: [],
    steps: [],
    takenKeys: [],
    asked: [],
    reviews: [],
    remaining: [],
    failure: null,
    step8: { pushed: false, prUrl: null, prPropertySet: false, moved: false },
    step10: { committed: false, changeset: null, docsToPropagate: null, releaseRow: null },
    pending: null,
  }
  const render = async (groom?: unknown) => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), 'build-summary-follow-ups-')))
    temps.push(repo)
    return renderBuildSummary({ ticket, state, repo, ...(groom === undefined ? {} : { groom: groom as GroomRecord }) })
  }

  it('T31 lists the build-may-go-on follow-up with its question and kind', async () => {
    const summary = await render(confirmed(answered, goingOn))
    const line = summary.split('\n').find((candidate) => candidate.includes('Which locale ships first?'))
    expect([line !== undefined, line?.includes('build may go on')]).toEqual([true, true])
  })

  it('T31 renders the summary it renders today when the record holds no follow-up', async () => {
    const today = await render()
    expect(await render(confirmed(answered))).toBe(today)
  })
})
