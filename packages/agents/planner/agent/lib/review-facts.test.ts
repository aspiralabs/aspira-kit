// T46 (F33), T47 (F34) and T48 (F35): the planner's review-facts module (plan P8; P28 creates
// packages/agents/planner/agent/lib/review-facts.ts and wires runner.ts's researchPrompt to it).
// This file imports that module, so it fails to collect until P28 lands (the task's planned reason).
//
// The contract these tests pin, since nothing exists yet to read it from:
//   reviewFacts({ folder, repoPath, repo: { commit, dirty } }) -> Promise<ReviewFactsResult>
//     `folder` is a ticket's working folder: it holds `ticket.md` and `spec.reviewed/` (trace/review.json,
//     spec.reviewed.md), exactly as a real ticket folder does (runner.ts:16-17, local.ts:167).
//     ReviewFactsResult = { included: boolean; reason: string; facts: string[]; uiEvidence: string[] }
//   renderFactsBlock(result) -> string appended to the research prompt; '' when result.included is false.
//   researchSteps(withFacts: boolean) -> 6 when true, else 10 (runner.ts:16-17 RESEARCH_STEPS).
// researchPrompt (runner.ts:89-91) is called through its existing export, with the rendered facts
// block as its third argument, to observe the exact prompt text a real research call would see.
//
// Seam (TEST-005): these are called directly, as a unit — no model, no MCP, no network. A real git
// repository stands in for commit ancestry and diffs (TEST-007: git is a local process, not mocked);
// facts and uiEvidence are plain evidence strings, exactly as spec-reviewer's Review schema holds
// them (review.ts: `facts: z.array(z.string())`).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TicketPage } from '@aspiralabs/agent-common/lib/board'
import { renderTicketMd } from '@aspiralabs/agent-common/lib/ticket'
import { researchInstructions } from './prompts.ts'
import { researchPrompt } from './runner.ts'
import { renderFactsBlock, researchSteps, reviewFacts } from './review-facts.ts'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const headOf = (dir: string): string => git(['rev-parse', 'HEAD'], dir)

/** A repository with one commit touching `src/base.ts`. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-facts-repo-'))
  temps.push(dir)
  git(['init', '-q'], dir)
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 't'], dir)
  await writeText(join(dir, 'src', 'base.ts'), 'export const BASE = 1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'base'], dir)
  return dir
}

/** One more commit on `dir`'s branch, writing `file`; returns the new HEAD. */
async function commitFile(dir: string, file: string, text: string, message: string): Promise<string> {
  await writeText(join(dir, file), text)
  git(['add', '-A'], dir)
  git(['commit', '-qm', message], dir)
  return headOf(dir)
}

/** A commit with no path back to `dir`'s current branch: an orphan history, checked out and back. */
async function unrelatedCommit(dir: string): Promise<string> {
  const branch = git(['branch', '--show-current'], dir)
  git(['checkout', '-q', '--orphan', 'unrelated'], dir)
  git(['rm', '-rf', '-q', '.'], dir)
  await writeText(join(dir, 'unrelated.txt'), 'x\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'unrelated'], dir)
  const sha = headOf(dir)
  git(['checkout', '-q', branch], dir)
  return sha
}

const CANDIDATE = '# Feature\n\nPagination caps a page at 50 items.\n'
const CANDIDATE_SHA = createHash('sha256').update(CANDIDATE).digest('hex')

/** A ticket's working folder: ticket.md with the given child pages, nothing under spec.reviewed/ yet. */
async function ticketFolder(repoDir: string, pages: Record<string, TicketPage> = {}): Promise<string> {
  const folder = join(repoDir, '.work', 'nom-9-pagination')
  await writeText(
    join(folder, 'ticket.md'),
    renderTicketMd({ id: 'NOM-9', title: 'Pagination', url: 'https://www.notion.so/nom-9', status: 'Ready: Spec', type: 'Feature', area: [], idea: 'Cap a page at 50 items.', pulledAt: '2026-10-13T09:00:00.000Z', pages }),
  )
  return folder
}

/** The spec reviewer's export under `folder`: the candidate spec and its trace/review.json. */
async function reviewer(folder: string, opts: { repoCommit?: string; repoDirty?: boolean; specSha256: string; specReviewedEditedAt?: string; facts: string[]; uiEvidence?: string[] }, specReviewedMd: string = CANDIDATE): Promise<void> {
  await writeText(join(folder, 'spec.reviewed', 'spec.reviewed.md'), specReviewedMd)
  const trace = {
    status: 'ready',
    input: { repoCommit: opts.repoCommit, repoDirty: opts.repoDirty ?? false },
    specSha256: opts.specSha256,
    ...(opts.specReviewedEditedAt === undefined ? {} : { specReviewedEditedAt: opts.specReviewedEditedAt }),
    reviews: [{ phase: 'security', output: { facts: opts.facts, uiEvidence: opts.uiEvidence ?? [], findings: [], checks: [], gaps: [] } }],
  }
  await writeText(join(folder, 'spec.reviewed', 'trace', 'review.json'), JSON.stringify(trace))
}

/** The prompt a real research call would see, with the facts block rendered in. */
function prompt(result: Awaited<ReturnType<typeof reviewFacts>>): string {
  return researchPrompt('BUSINESS SPEC (data)', researchInstructions, renderFactsBlock(result))
}

const FACT = 'src/base.ts:1: BASE is exported'
const noFactsIn = (text: string) => !text.includes(FACT) && !text.includes('SPEC REVIEW FACTS')

describe('T46 (F33): the reviewer\'s facts are included when the spec and the commit still match', () => {
  it('HEAD and clean: cites the facts and uiEvidence as evidence at repoCommit, without re-reading', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const folder = await ticketFolder(dir)
    await reviewer(folder, { repoCommit: head, repoDirty: false, specSha256: CANDIDATE_SHA, facts: [FACT], uiEvidence: ['src/base.ts:1: no UI here'] })
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    const text = prompt(result)
    expect({
      included: result.included,
      hasFact: text.includes(FACT),
      hasUiEvidence: text.includes('src/base.ts:1: no UI here'),
      namesCommit: text.includes(head),
      noReread: text.includes('without re-reading'),
    }).toEqual({ included: true, hasFact: true, hasUiEvidence: true, namesCommit: true, noReread: true })
  })

  it('an older ancestor commit: lists the files touched since then and requires re-reading facts that cite them', async () => {
    const dir = await repo()
    const base = headOf(dir)
    const head = await commitFile(dir, 'src/a.ts', 'export const A = 1\n', 'touch a')
    const folder = await ticketFolder(dir)
    await reviewer(folder, { repoCommit: base, repoDirty: false, specSha256: CANDIDATE_SHA, facts: ['src/a.ts:1: A is exported', FACT] })
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    const text = prompt(result)
    expect({ included: result.included, listsTouchedFile: text.includes('src/a.ts'), requiresReread: text.includes('must be re-read') }).toEqual({ included: true, listsTouchedFile: true, requiresReread: true })
  })

  it('a dirty working tree: every fact must be re-read before it is cited', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const folder = await ticketFolder(dir)
    await reviewer(folder, { repoCommit: head, repoDirty: false, specSha256: CANDIDATE_SHA, facts: [FACT] })
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: true } })
    expect(prompt(result)).toContain('every fact must be re-read before it is cited')
  })

  it('a pulled spec whose Spec Reviewed last-edited time is unchanged: facts stay in even though the pulled bytes differ from the export', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const editedAt = '2026-10-13T10:00:00.000Z'
    const folder = await ticketFolder(dir, { 'Spec Reviewed': { id: 'sr1', title: 'Spec Reviewed', url: 'https://www.notion.so/sr1', lastEditedAt: editedAt } })
    // The export recorded the hash of the original candidate; the pulled copy on disk now differs by
    // a trailing byte Notion's round-trip introduced, but the page's last-edited time has not moved.
    await reviewer(folder, { repoCommit: head, repoDirty: false, specSha256: CANDIDATE_SHA, specReviewedEditedAt: editedAt, facts: [FACT] }, `${CANDIDATE}\n`)
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    expect(result.included).toBe(true)
  })
})

describe('T47 (F34): facts are withheld, with a named reason, once they no longer apply', () => {
  it('no reviewer trace: spec.reviewed/trace/review.json does not exist', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const folder = await ticketFolder(dir)
    await writeText(join(folder, 'spec.reviewed', 'spec.reviewed.md'), CANDIDATE)
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    expect({ included: result.included, namesNoTrace: /trace|review\.json/i.test(result.reason), budget: researchSteps(result.included), noFacts: noFactsIn(prompt(result)) }).toEqual({ included: false, namesNoTrace: true, budget: 10, noFacts: true })
  })

  it('the spec hash and the Spec Reviewed last-edited time both differ from what was recorded', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const folder = await ticketFolder(dir, { 'Spec Reviewed': { id: 'sr1', title: 'Spec Reviewed', url: 'https://www.notion.so/sr1', lastEditedAt: '2026-01-01T00:00:00.000Z' } })
    await reviewer(folder, { repoCommit: head, repoDirty: false, specSha256: CANDIDATE_SHA, specReviewedEditedAt: '2026-10-13T10:00:00.000Z', facts: [FACT] }, `${CANDIDATE}changed\n`)
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    expect({ included: result.included, namesMismatch: /hash|last-edited/i.test(result.reason), budget: researchSteps(result.included), noFacts: noFactsIn(prompt(result)) }).toEqual({ included: false, namesMismatch: true, budget: 10, noFacts: true })
  })

  it('the review trace has no repoCommit to label the facts with', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const folder = await ticketFolder(dir)
    await reviewer(folder, { repoDirty: false, specSha256: CANDIDATE_SHA, facts: [FACT] })
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    expect({ included: result.included, namesMissingCommit: /repoCommit/i.test(result.reason) && /missing/i.test(result.reason), budget: researchSteps(result.included), noFacts: noFactsIn(prompt(result)) }).toEqual({ included: false, namesMissingCommit: true, budget: 10, noFacts: true })
  })

  it('the review trace\'s repoCommit is not an ancestor of HEAD', async () => {
    const dir = await repo()
    const head = headOf(dir)
    const unrelated = await unrelatedCommit(dir)
    const folder = await ticketFolder(dir)
    await reviewer(folder, { repoCommit: unrelated, repoDirty: false, specSha256: CANDIDATE_SHA, facts: [FACT] })
    const result = await reviewFacts({ folder, repoPath: dir, repo: { commit: head, dirty: false } })
    expect({ included: result.included, namesNotAncestor: /ancestor/i.test(result.reason), budget: researchSteps(result.included), noFacts: noFactsIn(prompt(result)) }).toEqual({ included: false, namesNotAncestor: true, budget: 10, noFacts: true })
  })
})

describe('T48 (F35): the research budget reflects whether facts were included', () => {
  it('gives research 6 turns when facts are included, else the full 10', () => {
    expect({ withFacts: researchSteps(true), withoutFacts: researchSteps(false) }).toEqual({ withFacts: 6, withoutFacts: 10 })
  })
})
