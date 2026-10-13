// Step 8 in the build-feature run (seam S1 with real git): after a clean code-analyzer result the
// driver commits the analyzer's changes, pushes the feature branch through its guard, opens or
// reuses a draft PR with gh, prints the set-pr stage and moves the card only once the PR property
// reads back. The repository is a real temp repo with a bare origin; gh is a fake executable on
// PATH that records its arguments and body files (the system boundary). KIT-11 plan P5: T27-T30.

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { BRANCH, PR_URL, branchFor, cleanup, project, taken, writeStepExport, type Project, type Result, type StepReportOptions } from './driver.test-helper.ts'

const exec = promisify(execFile)
afterEach(cleanup)

const SLOW = 120_000
const returnOn = (...names: string[]) => Object.fromEntries(names.map((name) => [name, async () => 'return' as const]))
const ASSUMPTION = taken('A1', 'Should the gate run in the app directory?')
const FIX_DECISION = { question: 'Should the fix keep the old retry limit?', options: ['Keep it', 'Raise it'], recommended: 'Keep it', reasoning: 'Nothing asked for a change', whyYours: 'It changes how the product behaves' }
const SAME_SESSION = /same session/i
const told = async (h: Project, result: Result) => `${result.text}\n${JSON.stringify(result.stage)}\n${await h.summary()}`
const forced = (args: string[]) => args.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg.startsWith('+'))

/** A build that finished at In Progress: Implementation; the code-analyzer reports clean and the run goes on to Step 8. */
async function analyzed(h: Project, report: StepReportOptions = {}, before?: () => Promise<void>): Promise<Result> {
  await writeStepExport(h.folder, h.repo, 'implementor', 'complete', { decisions: [ASSUMPTION] })
  const analyzer = await h.advance({}, await h.start())
  await before?.()
  await h.report(analyzer.stage, 'clean', report)
  return h.advance(returnOn('set-pr', 'move'))
}

describe('T27 F23: the analyzer changes are committed without the analyzer or work folders', () => {
  it('commits the source changes citing KIT-11 and nothing under .static-analysis/ or .work/', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    await analyzed(h)
    const subject = (await h.git('log', '-1', '--format=%s', `${h.base}..HEAD`, '--', 'src/app.ts')).stdout.trim()
    const files = await h.filesSince(h.base)
    expect({ cites: subject.includes('KIT-11'), source: files.includes('src/app.ts'), excluded: files.filter((file) => file.startsWith('.static-analysis/') || file.startsWith('.work/')) }).toEqual({ cites: true, source: true, excluded: [] })
  }, SLOW)

  it('stops before any push, naming a stray file outside the analyzer changes', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    const end = await analyzed(h, {}, () => writeFile(join(h.repo, 'notes.txt'), 'scratch\n'))
    expect({ end: end.stage?.stage, named: (await told(h, end)).includes('notes.txt'), origin: await h.originHead(), gh: (await h.ghCalls()).length }).toEqual({ end: 'end', named: true, origin: null, gh: 0 })
  }, SLOW)
})

describe('T28 F24: the push guard', () => {
  it('refuses to push from main, from another branch, or to an origin aspira.json does not name, and calls no gh', async () => {
    const variants = [
      { name: 'on main', options: { branch: 'main' }, reason: /\bmain\b/ },
      { name: 'other branch', options: { branch: 'feat/other' }, reason: /feat\/other/ },
      { name: 'other origin', options: { aspira: { board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad', repository: 'aspiralabs/other' } }, reason: /aspiralabs\/other|origin/i },
    ]
    const outcomes = []
    for (const variant of variants) {
      const h = await project({ status: 'In Progress: Implementation', ...variant.options })
      const end = await analyzed(h)
      const pushes = (await h.gitCalls()).filter((args) => args.includes('push'))
      outcomes.push({ name: variant.name, end: end.stage?.stage, reason: variant.reason.test(await told(h, end)), pushes: pushes.length, gh: (await h.ghCalls()).length })
    }
    expect(outcomes).toEqual(variants.map((variant) => ({ name: variant.name, end: 'end', reason: true, pushes: 0, gh: 0 })))
  }, SLOW)

  it('stops with the rejection in build-summary.md when the remote branch moved on, and never forces', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    const other = join(h.dir, 'other')
    await exec('git', ['clone', '-q', h.origin, other])
    await exec('git', ['-C', other, 'switch', '-q', '-c', BRANCH])
    await writeFile(join(other, 'elsewhere.md'), 'another session\n')
    await exec('git', ['-C', other, 'add', '.'])
    await exec('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'elsewhere file'])
    await exec('git', ['-C', other, 'push', '-q', 'origin', BRANCH])
    const end = await analyzed(h)
    const pushes = (await h.gitCalls()).filter((args) => args.includes('push'))
    expect({ end: end.stage?.stage, rejection: /rejected|non-fast-forward|fetch first/i.test(await h.summary()), tried: pushes.length > 0, forced: pushes.filter(forced) }).toEqual({ end: 'end', rejection: true, tried: true, forced: [] })
  }, SLOW)
})

describe('F50: the push from the worktree', () => {
  it('pushes with git push -u origin HEAD from the worktree, never forced', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    await analyzed(h)
    const pushes = (await h.gitCalls()).filter((args) => args.includes('push'))
    const head = (await h.git('rev-parse', 'HEAD')).stdout.trim()
    expect({ pushes, origin: await h.originHead() }).toEqual({ pushes: [['push', '-u', 'origin', 'HEAD']], origin: head })
  }, SLOW)

  it('builds a Bug on fix/kit-11-x: the guard, the push and the PR head use the Type prefix', async () => {
    const h = await project({ status: 'In Progress: Implementation', type: 'Bug', branch: branchFor('Bug') })
    const setPr = await analyzed(h)
    const create = (await h.ghCalls()).find(({ args }) => args[0] === 'pr' && args[1] === 'create')
    const head = create?.args[create.args.indexOf('--head') + 1]
    expect({ stage: setPr.stage?.stage, origin: (await h.originHead(branchFor('Bug'))) !== null, head }).toEqual({ stage: 'set-pr', origin: true, head: 'fix/kit-11-x' })
  }, SLOW)
})

describe('T29 F25: Step 8 is safe to repeat', () => {
  it('reuses an open PR for the branch and carries its URL in the set-pr stage', async () => {
    const existing = 'https://github.com/aspiralabs/fixture/pull/3'
    const h = await project({ status: 'In Progress: Implementation', existingPr: existing })
    const setPr = await analyzed(h)
    const creates = (await h.ghCalls()).filter(({ args }) => args[0] === 'pr' && args[1] === 'create')
    expect({ stage: setPr.stage?.stage, url: setPr.stage?.url, creates: creates.length }).toEqual({ stage: 'set-pr', url: existing, creates: 0 })
  }, SLOW)

  it('creates one PR across a stop and a rerun, and moves only after the PR property reads back', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    await analyzed(h)
    await h.stop()
    let resolvedPr: string | null = null
    const move = await h.advance(
      {
        resolve: async (stage) => {
          resolvedPr = h.card.pr
          await h.answer(stage, h.resolution())
        },
        move: async () => 'return',
      },
      await h.start(),
    )
    const creates = (await h.ghCalls()).filter(({ args }) => args[0] === 'pr' && args[1] === 'create')
    expect({ creates: creates.length, move: move.stage?.stage === 'move' ? move.stage.to : move.stage?.stage, readBack: resolvedPr }).toEqual({ creates: 1, move: 'In Review: Implementation', readBack: PR_URL })
  }, SLOW)
})

describe('T30 F26: the PR description lists the decisions taken after Ready: Plan first', () => {
  it('passes gh pr create --draft a body listing A1, then the same-session notice, then the Build Summary link', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    await analyzed(h)
    const create = (await h.ghCalls()).find(({ args }) => args[0] === 'pr' && args[1] === 'create')
    const body = create?.body ?? ''
    const at = [body.indexOf(ASSUMPTION.question), body.search(SAME_SESSION), body.indexOf('Build Summary')]
    expect({ draft: create?.args.includes('--draft') ?? false, found: at.every((index) => index >= 0), ordered: at[0]! < at[1]! && at[1]! < at[2]! }).toEqual({ draft: true, found: true, ordered: true })
  }, SLOW)

  it('rewrites the body with gh pr edit after a fix push and at the end, listing the fix decision in the first section', async () => {
    const h = await project({ status: 'In Progress: Implementation' })
    const setPr = await analyzed(h)
    const step10 = await h.advance({}, setPr)
    await h.answer(step10.stage, { docs: [], docsToPropagate: 'none' })
    const review = await h.advance()
    await h.report(review.stage, 'complete', { findings: [{ id: 'H1', severity: 'high', title: 'The retry never stops', file: 'src/app.ts' }] })
    const fix = await h.advance()
    await h.write('src/app.ts', 'export const app = 3 // fixed\n')
    const callsBefore = (await h.ghCalls()).length
    await h.answer(fix.stage, { decisions: [FIX_DECISION], usage: { tokens: 500, wallMs: 20000 } })
    const second = await h.advance()
    await h.report(second.stage, 'complete', { findings: [] })
    await h.advance()
    const edits = (await h.ghCalls()).slice(callsBefore).filter(({ args }) => args[0] === 'pr' && args[1] === 'edit')
    const listed = edits.map(({ body }) => {
      const text = body ?? ''
      const notice = text.search(SAME_SESSION)
      return text.indexOf(FIX_DECISION.question) >= 0 && text.indexOf(FIX_DECISION.question) < notice && text.indexOf(ASSUMPTION.question) < notice
    })
    expect({ edits: edits.length >= 2, listed: listed.every(Boolean) }).toEqual({ edits: true, listed: true })
  }, SLOW)
})
