// T22 (F22, F27): the implementor --local driver refuses a wrong branch in the board stage, before
// the claim and the start move (GIT-001's ticketBranch), and a run that does not end ready never
// names Step 7 or Step 8 as its Next action and never moves the card. Seam: scripts/local.ts as a
// real child process, observed through the JSON it prints (TEST-003, TEST-005, TEST-007): the same
// seam build-feature's own driver tests use.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRANCH, FOLDER_NAME, ID, cleanup, readTicketFile, repo, runDriver, writeGuidelines, writePlan, writeTicket } from './driver-test-helper.ts'

afterEach(cleanup)

/**
 * The board stage of a fresh --local run: the first call always asks the session to resolve the
 * ticket (it does not yet know ticket.md is current). Rewriting it, as the session's resolve
 * action would, makes the next call see it as current and go on to the claim.
 */
async function pastResolve(root: string): Promise<void> {
  await runDriver(['--repo', root, '--ticket', ID], { cwd: root })
  const folder = join(root, '.work', FOLDER_NAME)
  const text = await readTicketFile(folder)
  await writeFile(join(folder, 'ticket.md'), text)
}

describe('T22 F22: the branch is gated before the claim', () => {
  it('on main the run ends refused with a non-zero exit, prints no move and no Dev set action, and its Next action is the switch command', async () => {
    const root = await repo({ branch: 'main' })
    const folder = await writeTicket(root, { status: 'Ready: Plan' })
    await pastResolve(root)

    const result = await runDriver(['--repo', root, '--ticket', ID], { cwd: root })
    const after = await readTicketFile(folder)

    expect({
      exitNonZero: result.code !== 0,
      status: result.json?.status,
      printsActions: result.json !== null && 'actions' in result.json,
      nextAction: typeof result.json?.reason === 'string' && result.json.reason.includes(`git switch -c ${BRANCH}`),
      ticketUnchanged: after.includes('| Status | Ready: Plan |') && after.includes('| Dev |  |'),
    }).toEqual({ exitNonZero: true, status: 'refused', printsActions: false, nextAction: true, ticketUnchanged: true })
  })

  it('the incomplete export names neither Step 7 nor Step 8 as Next action and prints no move', async () => {
    const root = await repo()
    const folder = await writeTicket(root, { status: 'In Progress: Implementation', dev: 'Claude' })
    await writePlan(folder)
    const guidelines = await writeGuidelines(root)
    await pastResolve(root)

    const result = await runDriver(['--repo', root, '--ticket', ID, '--guidelines', guidelines, '--finish'], { cwd: root })

    expect(result.json?.status).toBe('incomplete')
    const board = result.json?.board as { actions?: unknown[]; remaining?: string | null } | undefined
    expect({
      move: (board?.actions ?? []).some((action) => typeof action === 'object' && action !== null && (action as { action?: string }).action === 'move'),
      namesStep: typeof board?.remaining === 'string' && (board.remaining.includes('Step 7') || board.remaining.includes('Step 8')),
    }).toEqual({ move: false, namesStep: false })
  })
})
