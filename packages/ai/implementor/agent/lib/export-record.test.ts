// T23 (F21, F22): a ready --local build's implementation-local.json records status, reason,
// reasonCode, branch, apps and head; and once the card's title changes, the Step 8 push command
// still names the recorded branch, with a note saying so. Seam: scripts/local.ts as a real child
// process, observed through the JSON it prints and the export it writes (TEST-003, TEST-007).

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRANCH, ID, buildReady, cleanup, readTicketFile, runDriver } from './driver-test-helper.ts'

afterEach(cleanup)

const exportFile = (folder: string) => join(folder, 'plan.review/trace/implementation-local.json')

describe('T23 F21, F22: the export records branch, apps and head', () => {
  it('a ready build records status ready, reason null, reasonCode null, the recorded branch, the changed app directories and head', async () => {
    const { folder, commit } = await buildReady()
    const record = JSON.parse(await readFile(exportFile(folder), 'utf8')) as Record<string, unknown>
    expect({ status: record.status, reason: record.reason ?? null, reasonCode: record.reasonCode ?? null, branch: record.branch, apps: record.apps, head: record.head }).toEqual({
      status: 'ready',
      reason: null,
      reasonCode: null,
      branch: BRANCH,
      apps: ['packages/a'],
      head: commit,
    })
  })

  it("after the card's title changes, the Step 8 push command still names the recorded branch and the note says so", async () => {
    const { root, folder } = await buildReady()

    const renamed = (await readTicketFile(folder)).replace(`# ${ID}: Every skill writes a progress note`, `# ${ID}: Renamed card`)
    await writeFile(join(folder, 'ticket.md'), renamed)

    const result = await runDriver(['--repo', root, '--ticket', ID, '--verify'], { cwd: root })
    const step8 = result.json?.step8 as { push?: string; note?: string } | undefined
    expect({ push: step8?.push, notesTheStay: typeof step8?.note === 'string' && step8.note.includes(`the branch stays ${BRANCH}`) }).toEqual({
      push: `git push -u origin ${BRANCH}`,
      notesTheStay: true,
    })
  })
})
