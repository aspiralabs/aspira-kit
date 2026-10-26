// The review loop down to medium and the merge after it (2026-10-23, from the NOM-38 run): a medium
// finding gets a fix like a high one, the project gate runs again on each fix before the next
// review, a fix that would contradict a ticket decision is asked in chat and handed to the next
// fix, and a review with nothing medium or above left ends in the run's own merge and the move to
// Ready: Implementation. A refused merge stops the run with the PR open and the card where it was.

import { existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { BOARD, PR_URL, RELEASES, REPOSITORY, cleanup, ofKind, project, writeStepExport, type Handler, type Project, type Stage } from './driver.test-helper.ts'
import { returnOn, told } from './driver.integration.shared.ts'
import { ISOLATED_ASPIRA, ISOLATED_IGNORE, isolationWorld, type World } from './isolation.test-helper.ts'
import { SLOW, SOURCE, high, reviewing, fix, reviewSteps, ghRan, toReview } from './review-loop.integration.shared.ts'

afterAll(cleanup)

const medium = (n: number) => [{ id: `M${n}`, severity: 'medium' as const, title: `Review ${n} found the counter has no fail-closed test`, file: 'src/a.ts' }]
const GATED = { 'AGENTS.md': '# Project\n\nBefore every pull request, run `pnpm check`.\n' }

describe('the review loop fixes medium findings and gates each fix', () => {
  it('prints a fix for a review that leaves only a medium, and does not mark the PR ready', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: medium(1) })
    const next = await h.advance()
    const findings = (next.stage?.findings ?? []) as { id: string; severity: string }[]
    expect({ stage: next.stage?.stage, findings: findings.map((finding) => `${finding.id}:${finding.severity}`), ready: await ghRan(h, 'ready') }).toEqual({ stage: 'fix', findings: ['M1:medium'], ready: 0 })
  }, SLOW)

  it('runs the project gate on the fix before the next review', async () => {
    const { h, review } = await reviewing({ files: GATED })
    await h.report(review.stage, 'complete', { findings: high(1) })
    await fix(h, await h.advance(), ['src/a.ts'])
    const gate = await h.advance()
    await h.answer(gate.stage!, { results: [{ command: 'pnpm check', exitCode: 0, output: 'ok' }] })
    const second = await h.advance()
    expect({ gate: gate.stage?.stage, commands: gate.stage?.commands, next: second.stage?.step }).toEqual({ gate: 'gate', commands: ['pnpm check'], next: 'pr-reviewer' })
  }, SLOW)

  it('stops on a failing gate after a fix, before the next review', async () => {
    const { h, review } = await reviewing({ files: GATED })
    await h.report(review.stage, 'complete', { findings: high(1) })
    await fix(h, await h.advance(), ['src/a.ts'])
    const gate = await h.advance()
    await h.answer(gate.stage!, { results: [{ command: 'pnpm check', exitCode: 1, output: 'FIX-BROKE-THE-GATE' }] })
    const end = await h.advance()
    expect({ end: end.stage?.stage, reviews: reviewSteps(h).length, tail: (await h.summary()).includes('FIX-BROKE-THE-GATE'), merges: await ghRan(h, 'merge') }).toEqual({ end: 'end', reviews: 1, tail: true, merges: 0 })
  }, SLOW)

  it('asks about a fix that contradicts a ticket decision and hands the answer to the next fix', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1) })
    const first = await h.advance()
    await h.answer(first.stage!, { decisions: [], conflicts: [{ finding: 'H1', decision: 'Q19', why: 'Q19 keeps one 403 message for every token failure.' }], usage: {} })
    const ask = await h.advance()
    await h.answer(ask.stage!, { answer: 'Keep Q19.' })
    const second = await h.advance()
    await h.report(second.stage, 'complete', { findings: high(2) })
    const again = await h.advance()
    expect({
      ask: ask.stage?.stage,
      names: String(ask.stage?.question ?? '').includes('Q19'),
      fix: again.stage?.stage,
      answered: again.stage?.answered,
    }).toEqual({ ask: 'ask', names: true, fix: 'fix', answered: [{ question: ask.stage?.question, answer: 'Keep Q19.' }] })
  }, SLOW)
})

describe('a card that reached In Review unanalyzed (NOM-38)', () => {
  it('runs the code analyzer before the first review and commits its fixes to the open PR, with no move', async () => {
    const { h, review } = await reviewing()
    const steps = ofKind(h.stages, 'step').map((stage) => String(stage.step))
    const commits = (await h.gitCalls()).filter((args) => args.includes('commit')).map((args) => args.join(' '))
    expect({
      order: steps.slice(0, 2),
      next: review.stage?.step,
      committed: commits.some((line) => line.includes('apply the code-analyzer fixes')),
      moves: ofKind(h.stages, 'move').length,
    }).toEqual({ order: ['code-analyzer', 'pr-reviewer'], next: 'pr-reviewer', committed: true, moves: 0 })
  }, SLOW)
})

describe('the merge after a clean review', () => {
  it('merges once with a merge commit, moves the card to Ready: Implementation and ends finished', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    const end = await h.advance()
    const merge = ofKind(h.stages, 'merge')[0]
    expect({
      end: end.stage?.stage,
      merges: await ghRan(h, 'merge'),
      run: merge?.run,
      moves: ofKind(h.stages, 'move').map((stage) => `${String(stage.from)} -> ${String(stage.to)}`),
      merged: String(end.stage?.message ?? '').includes('merged the PR'),
    }).toEqual({ end: 'end', merges: 1, run: [`gh pr checks ${String(merge?.pr)} --watch --fail-fast`, `gh pr merge ${String(merge?.pr)} --merge`], moves: ['In Review: Implementation -> Ready: Implementation'], merged: true })
  }, SLOW)

  it('updates the release page entry after the merge, before the move, when aspira.json names releases', async () => {
    const { h, review } = await reviewing({ aspira: { board: BOARD, repository: REPOSITORY, releases: RELEASES } })
    await h.report(review.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    let stage = await h.advance()
    const order: string[] = []
    for (let turn = 0; turn < 6 && stage.stage?.stage === 'release-row'; turn += 1) {
      const part = String(stage.stage.part)
      order.push(part)
      if (part === 'draft') await h.answer(stage.stage, { customerLine: 'You can now save a recipe for later.', existingRow: false })
      else await h.answer(stage.stage, { done: true })
      stage = await h.advance()
    }
    const merged = ofKind(h.stages, 'release-row').find((candidate) => candidate.part === 'merged')
    expect({
      order,
      end: stage.stage?.stage,
      writes: merged?.notion,
      checklist: String(merged?.instructions ?? '').includes('checked on dev'),
      afterMerge: h.stages.indexOf(merged!) > h.stages.indexOf(ofKind(h.stages, 'merge')[0]!),
      moves: ofKind(h.stages, 'move').map((candidate) => String(candidate.to)),
    }).toEqual({ order: ['draft', 'write', 'merged'], end: 'end', writes: [{ op: 'write', target: 'release-page' }], checklist: true, afterMerge: true, moves: ['Ready: Implementation'] })
  }, SLOW)

  it('stops with the PR open and no move when the merge is refused', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: [] })
    const end = await h.advance({ merge: async (stage) => (await h.answer(stage, { error: 'gh pr checks: 1 failing check' }), undefined) })
    expect({ end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, said: (await h.summary()).includes('1 failing check') }).toEqual({ end: 'end', moves: 0, said: true })
  }, SLOW)
})

// KIT-67 T34 (F24): after the merge is recorded and before the release row and the move, the run tears the
// worktree's database branch, tunnel, DNS record and Stripe endpoints down once, records the result in the merge
// record, and never lets a failed teardown block the release row or the move. The services are stood in for as
// in worktree.integration.test.ts (isolation.test-helper.ts); the worktree starts out already isolated, as the
// kit's step 1 leaves it: the seeded resources, a consistent .env.development.local and .aspira/cloudflared.yml.
describe('KIT-67 T34: the teardown after the merge', () => {
  const worlds: World[] = []
  afterAll(async () => {
    for (const world of worlds) await world.close()
  })

  async function isolatedReviewing(options: { releases?: boolean } = {}) {
    const world = await isolationWorld()
    worlds.push(world)
    const aspira = { ...ISOLATED_ASPIRA, ...(options.releases === true ? { releases: RELEASES } : {}) }
    const h = await project({ status: 'In Review: Implementation', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, '.gitignore': ISOLATED_IGNORE }, aspira, env: world.env })
    await world.install(h.dir)
    world.mocks.seed('kit-11')
    const tunnel = world.mocks.state.tunnels[0]!
    const url = 'http://kit-11.localhost:3001'
    await h.write('.env.development.local', `DATABASE_URL=postgresql://owner:pw@pooler-ep-wt-kit-11.neon.test/db?sslmode=require\nPORT=3001\nBETTER_AUTH_URL=${url}\nNEXT_PUBLIC_APP_URL=${url}\nSTRIPE_WEBHOOK_SECRET=whsec_seed_kit-11\n`)
    await h.write('.aspira/cloudflared.yml', `tunnel: ${tunnel.id}\ncredentials-file: ${h.dir}/.cloudflared/${tunnel.id}.json\ningress:\n  - hostname: kit-11-branch.aspiralabs.co\n    path: ^/api/webhooks/stripe$\n    service: http://localhost:3001\n  - service: http_status:404\n`)
    world.mocks.probe = () => (existsSync(h.repo) ? 'worktree present' : 'worktree gone')
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const review = await toReview(h, await h.start())
    await h.report(review.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    return { h, world }
  }

  /** Answer the release page's parts like the session would; `merged` is what the last part answers. */
  const releasePage =
    (h: Project, merged: Record<string, unknown>): Handler =>
    async (stage: Stage) => {
      const part = String(stage.part)
      if (part === 'draft') await h.answer(stage, { customerLine: 'You can now save a recipe for later.', existingRow: false })
      else await h.answer(stage, part === 'merged' ? merged : { done: true })
    }

  const mergeRecord = async (h: Project) => ((await h.state()).phases as { merge?: Record<string, unknown> } | undefined)?.merge
  const deletes = (world: World) => world.mocks.events.filter((event) => event.op.endsWith('.delete')).length

  it('deletes the endpoints, tunnel, CNAME and branch after the merge record, records teardown done, moves the card and leaves the worktree folder', async () => {
    const { h, world } = await isolatedReviewing()
    const atMerge = await h.advance(returnOn('merge'))
    const before = { stage: atMerge.stage?.stage, events: world.mocks.events.length, resources: [world.mocks.state.tunnels.length, world.mocks.state.cnames.length, world.mocks.state.endpoints.length] }
    const end = await h.advance({}, atMerge)
    const { state } = world.mocks
    expect({
      before,
      end: end.stage?.stage,
      branches: state.branches.map((branch) => branch.name),
      resources: [state.tunnels.length, state.cnames.length, state.endpoints.length],
      teardown: (await mergeRecord(h))?.teardown,
      moves: ofKind(h.stages, 'move').map((stage) => `${String(stage.from)} -> ${String(stage.to)}`),
      folder: existsSync(h.repo),
      observed: [...new Set(world.mocks.events.map((event) => event.observed))],
    }).toEqual({
      before: { stage: 'merge', events: 0, resources: [1, 1, 1] },
      end: 'end',
      branches: ['main', 'dev'],
      resources: [0, 0, 0],
      teardown: 'done',
      moves: ['In Review: Implementation -> Ready: Implementation'],
      folder: true,
      observed: ['worktree present'],
    })
  }, SLOW)

  it('makes no teardown call again when the run is resumed after the merge record', async () => {
    const { h, world } = await isolatedReviewing({ releases: true })
    // The release page fails after the merge was recorded and torn down: the run stops, the card stays In Review.
    const stopped = await h.advance({ 'release-row': releasePage(h, { error: 'notion is down' }) }, await h.advance(returnOn('merge')))
    const recorded = (await mergeRecord(h))?.teardown
    const deletedBefore = deletes(world)
    const resumed = await h.advance({ 'release-row': releasePage(h, { done: true }) }, await h.start())
    expect({
      stopped: stopped.stage?.stopped,
      recorded,
      deleted: deletedBefore > 0,
      repeated: deletes(world) !== deletedBefore,
      end: resumed.stage?.stage,
      moves: ofKind(h.stages, 'move').map((stage) => String(stage.to)),
    }).toEqual({ stopped: true, recorded: 'done', deleted: true, repeated: false, end: 'end', moves: ['Ready: Implementation'] })
  }, SLOW)

  it('records teardown failed with the webhooks step when Stripe fails on delete, lists run kit cleanup in the report, and still writes the release row and moves the card', async () => {
    const { h, world } = await isolatedReviewing({ releases: true })
    world.failStripeDelete = true
    const end = await h.advance({ 'release-row': releasePage(h, { done: true }) }, await h.advance(returnOn('merge')))
    const record = await mergeRecord(h)
    expect({
      teardown: record?.teardown,
      step: JSON.stringify(record).includes('webhooks'),
      followUp: (await told(h, end)).includes('kit cleanup'),
      releaseRow: ofKind(h.stages, 'release-row').some((stage) => stage.part === 'merged'),
      moves: ofKind(h.stages, 'move').map((stage) => String(stage.to)),
      end: end.stage?.stage,
      stopped: Boolean(end.stage?.stopped),
    }).toEqual({ teardown: 'error', step: true, followUp: true, releaseRow: true, moves: ['Ready: Implementation'], end: 'end', stopped: false })
  }, SLOW)
})
