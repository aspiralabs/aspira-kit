// T20 (F24, F26): the implementor driver's `--verify` takes the PR URL through `--pr-url` and runs
// the shared two-stage board step (pr-step.ts's `prStep`, F24, F25); without `--pr-url` it sets and
// moves nothing and reports Step 8 still open. Seam: scripts/local.ts as a real child process, with a
// fake `gh` on PATH (the boundary the shared PR check calls through, TEST-003, TEST-007).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRANCH, ID, buildReady, cleanup, runDriver } from './driver-test-helper.ts'

afterEach(cleanup)

/** A fake `gh` answering `pr view <url> --json ...` with a valid, open, same-repository PR whose
 * head is HEAD and whose branch is BRANCH: the PR the ready build's own Step 8 would open. */
const FAKE_GH = (url: string, head: string) => `#!/bin/bash
if [ "$1 $2" = "pr view" ]; then
  printf '{"url":"%s","state":"OPEN","headRefName":"%s","headRefOid":"%s","headRepository":"aspiralabs/kit","headRepositoryOwner":"aspiralabs","isCrossRepository":false,"baseRefName":"main"}\\n' "${url}" "${BRANCH}" "${head}"
  exit 0
fi
exit 0
`

async function withGh(root: string, head: string, url: string): Promise<{ PATH: string }> {
  const bin = join(root, '.bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), FAKE_GH(url, head), { mode: 0o755 })
  return { PATH: `${bin}:${process.env.PATH ?? ''}` }
}

describe('T20 F24, F26: implementor --verify --pr-url', () => {
  it('without --pr-url reports no set or move action and Step 8 still open, and progress.md keeps Step 8 as Next action', async () => {
    const { root, folder, commit } = await buildReady()
    const progress = join(folder, 'progress.md')
    await writeFile(progress, '## Next action\n\nStep 8: commit, push, open the PR and verify.\n')
    const env = await withGh(root, commit, `https://github.com/aspiralabs/kit/pull/7`)

    const result = await runDriver(['--repo', root, '--ticket', ID, '--verify'], { cwd: root, env })
    const step8 = result.json?.step8 as { open?: boolean; action?: string } | undefined
    const after = await readFile(progress, 'utf8')

    expect({ action: step8?.action, open: step8?.open, progressNamesStep8: after.includes('Step 8') }).toEqual({ action: undefined, open: true, progressNamesStep8: true })
  })

  it('with --pr-url for the valid PR, the output carries exactly one set action for the PR property', async () => {
    const { root, commit } = await buildReady()
    const url = 'https://github.com/aspiralabs/kit/pull/7'
    const env = await withGh(root, commit, url)

    const result = await runDriver(['--repo', root, '--ticket', ID, '--verify', '--pr-url', url], { cwd: root, env })
    const step8 = result.json?.step8 as { action?: string } | undefined

    expect(step8?.action).toBe('set')
  })
})
