// T49 (F33): the spec reviewer's export records the exported spec's hash next to the repository
// state it was reviewed at, and a passing --verify records the Spec Reviewed page's last-edited
// time in the same trace (plan P8; P28 adds specSha256 to local.ts/runner.ts's export and the
// specReviewedEditedAt write to scripts/local.ts's --verify branch, evidence local.ts:167). Neither
// exists yet, so this test fails now: trace/review.json has input.repoCommit/repoDirty but no
// specSha256, and --verify leaves the trace exactly as it found it.
//
// Seams (TEST-005): the --local export, through runLocal (agent/lib/local.ts) — the public function
// every --local caller uses — observed by reading the exported trace/review.json; and the real
// scripts/local.ts CLI as a child process for --verify (TEST-003/007: no mock needed there — the
// board's --verify step never calls Notion or GitHub, it only reads ticket.md and the trace it wrote
// on export, both local files).
//
// repository() is mocked at its own module boundary (TEST-003/007: the project's git process
// boundary, not an internal collaborator), exactly as the existing local.test.ts does, so the
// pipeline runs without a real repository under the ticket folder.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { renderTicketMd, workFolderName, type BoardTrace } from '@aspiralabs/agent-common/lib/ticket'
import { writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'fixture-commit-sha', dirty: false, tools: {} }) }))
import { runLocal } from './local.ts'
import { writeSnapshot } from './snapshot.test-helper.ts'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const DRIVER = join(PACKAGE, 'scripts/local.ts')

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

const candidate = '# Feature\n## Intent\nPaginate lists.\n## Acceptance criteria\n### Features\n- [ ] F1: Cap a page at 50 items.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Original' }], uiEvidence: [], gaps: [] })
const finding = (title: string) => ({ title, severity: 'medium', whatThisMeans: 'Members would see something other than the spec promises.', evidence: ['spec: Original'], fix: 'Add intent and acceptance' })

const TICKET_ID = 'NOM-9'
const TICKET_URL = 'https://www.notion.so/nom-9'

function ticketMd(pages: Parameters<typeof renderTicketMd>[0]['pages']): string {
  return renderTicketMd({ id: TICKET_ID, title: 'Pagination', url: TICKET_URL, status: 'In Review: Spec', type: 'Feature', area: [], idea: 'Cap a page at 50 items.', pulledAt: '2026-10-13T09:00:00.000Z', pages })
}

/** A ticket's working folder, ready for the spec reviewer: ticket.md, the spec and the guidelines. */
async function ticketProject(): Promise<{ root: string; folder: string; reportDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'spec-hash-'))
  temps.push(root)
  await writeText(join(root, 'aspira.json'), `${JSON.stringify({ board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad' }, null, 2)}\n`)
  const folder = join(root, '.work', workFolderName({ id: TICKET_ID, title: 'Pagination' }))
  await writeText(join(folder, 'ticket.md'), ticketMd({}))
  await writeText(join(folder, 'spec.md'), '# Original')
  await writeSnapshot(join(folder, 'rules.md'))
  return { root, folder, reportDir: join(folder, 'spec.reviewed') }
}

/** Drive the --local pipeline through research, the six specialists and synthesis, to a ready export. */
async function exportReadyReview(input: { specPath: string; guidelinesPath: string; repoPath: string; uiRequired: boolean }) {
  const research = await runLocal(input)
  if (!research.pending) throw new Error('expected pending research')
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([finding('Missing contract')])))
  const specialists = await runLocal(input)
  if (!specialists.pending) throw new Error('expected pending specialists')
  for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))
  const synthesis = await runLocal(input)
  if (!synthesis.pending) throw new Error('expected pending synthesis')
  await writeFile(
    synthesis.tasks[0]!.output,
    JSON.stringify({
      edits: [{ id: 'E1', before: '# Original', after: candidate }],
      dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Repair acceptance contract', evidence: ['spec: Original'], editIds: ['E1'], duplicateOf: null }],
    }),
  )
  const done = await runLocal(input)
  if (done.pending) throw new Error('expected the export')
  return done
}

it('exports trace/review.json with the candidate\'s sha256 beside input.repoCommit and input.repoDirty, then records the Spec Reviewed page\'s last-edited time at --verify', async () => {
  const { root, folder, reportDir } = await ticketProject()
  const input = { specPath: join(folder, 'spec.md'), guidelinesPath: join(folder, 'rules.md'), repoPath: folder, uiRequired: false }
  const done = await exportReadyReview(input)
  expect(done.status).toBe('ready')

  const exported = await readFile(join(reportDir, 'spec.reviewed.md'), 'utf8')
  const expectedHash = createHash('sha256').update(exported).digest('hex')
  // Validated boundary: this is our own fixture's export, read back as the shape local.ts/runner.ts write.
  const afterExport = JSON.parse(await readFile(join(reportDir, 'trace', 'review.json'), 'utf8')) as { specSha256?: string; input: { repoCommit: string; repoDirty: boolean } }
  expect({ specSha256: afterExport.specSha256, repoCommit: afterExport.input.repoCommit, repoDirty: afterExport.input.repoDirty }).toEqual({ specSha256: expectedHash, repoCommit: 'fixture-commit-sha', repoDirty: false })

  // The board trace an end-of-run stage would have written: only the Spec Reviewed page left to push.
  const trace: BoardTrace = { skill: 'spec-reviewer', ticket: { id: TICKET_ID, title: 'Pagination', url: TICKET_URL }, folder, statusBefore: 'In Review: Spec', statusAfter: 'In Review: Spec', expected: 'In Review: Spec', pushing: ['Spec Reviewed'], pushed: [], actions: [] }
  await writeBoardTrace(reportDir, trace)
  const editedAt = '2026-10-13T10:00:00.000Z'
  await writeText(join(folder, 'ticket.md'), ticketMd({ 'Spec Reviewed': { id: 'sr1', title: 'Spec Reviewed', url: 'https://www.notion.so/sr1', lastEditedAt: editedAt } }))

  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, AI_GATEWAY_API_KEY: _gateway, ...rest } = process.env
  const outcome = await exec(process.execPath, ['--experimental-strip-types', DRIVER, '--repo', root, '--ticket', TICKET_ID, '--verify'], { cwd: root, env: rest }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code?: number; stdout?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '' }),
  )
  // Validated boundary: our own CLI's stdout, which the script always prints as one JSON object.
  const verified = JSON.parse(outcome.stdout || '{}') as { verified?: boolean }
  const afterVerify = JSON.parse(await readFile(join(reportDir, 'trace', 'review.json'), 'utf8')) as { specReviewedEditedAt?: string }
  expect({ exit: outcome.code, verified: verified.verified, specReviewedEditedAt: afterVerify.specReviewedEditedAt }).toEqual({ exit: 0, verified: true, specReviewedEditedAt: editedAt })
})
