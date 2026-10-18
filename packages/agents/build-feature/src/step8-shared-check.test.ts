// T32 (F24): step8.ts's openOrReusePr reuses any URL `gh pr list --head <branch>` prints
// (step8.ts:232-238), and that list is filtered by --head only (system.ts:61) — a pull request
// opened from someone's fork can use the same branch name. The spec's shared check (reviewed spec,
// F24: "including step8.ts's open-PR reuse, whose PR_URL pattern is replaced by the same one, so a
// fork PR with the ticket's branch name is never reused or set... A test with a cross-repository PR
// carrying the ticket branch name ends refused naming headRepository") is not built yet, so Step 8
// still reuses the fork PR today. This test drives the real phase (step8Phase.next, the seam
// step8Next runs behind, TEST-005) against a real temp git repository on the ticket's branch; gh is
// a fake executable on PATH standing in for the network/process boundary (TEST-003, TEST-007),
// answering `pr list` and `pr view` the way a fork PR really looks (isCrossRepository true). It
// fails for that reason until the shared check lands.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { PhaseContext } from '#src/driver.ts'
import { emptyRunState, type RunState } from '#src/run-state.ts'
import { step8Phase } from '#src/step8.ts'

const exec = promisify(execFile)

const ID = 'KIT-2'
const TITLE = 'X'
const BRANCH = 'feat/kit-2-x'
const ORIGIN = 'https://github.com/aspiralabs/kit.git'
const FORK_PR_URL = 'https://github.com/other-org/kit/pull/9'
const FORK_SHA = 'f'.repeat(40)

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

// Answers `pr list` and `pr view` as real gh would for a fork PR carrying the ticket's branch name:
// isCrossRepository true, headRepository/headRepositoryOwner naming the fork, built with jq so the
// JSON is never hand-escaped bash (and --jq filters, as the current GH_ARGS.prList uses, run for real).
const FAKE_GH = `#!/bin/bash
sub="$1 $2"
build() {
  jq -n --arg url "$FORK_PR_URL" --arg branch "$FORK_BRANCH" --arg sha "$FORK_SHA" \\
    '{url:$url, number:9, state:"OPEN", isDraft:true, headRefName:$branch, headRepository:{name:"kit"}, headRepositoryOwner:{login:"other-org"}, isCrossRepository:true, headRefOid:$sha, baseRefName:"main"}'
}
case "$sub" in
  "pr list") json="$(build | jq -s '.')" ;;
  "pr view") json="$(build)" ;;
  *) exit 0 ;;
esac
filter=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[$i]}" = "--jq" ] || [ "\${args[$i]}" = "-q" ]; then
    filter="\${args[$((i + 1))]}"
  fi
done
if [ -n "$filter" ]; then
  echo "$json" | jq -r "$filter"
else
  echo "$json"
fi
`

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A real temp repository on the ticket branch, origin aspiralabs/kit, with gh faked as a fork PR for that branch. */
async function repoOnTicketBranch(): Promise<{ repo: string; env: NodeJS.ProcessEnv; head: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-step8-shared-')))
  temps.push(dir)
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await exec('git', ['init', '-q', '-b', 'main', repo])
  await git(repo, 'remote', 'add', 'origin', ORIGIN)
  await writeFile(join(repo, 'README.md'), '# Fixture\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'init')
  await git(repo, 'switch', '-q', '-c', BRANCH)
  await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FORK_PR_URL, FORK_BRANCH: BRANCH, FORK_SHA }
  return { repo, env, head }
}

function contextFor(repo: string, env: NodeJS.ProcessEnv): PhaseContext {
  return {
    id: ID,
    repo,
    folder: join(repo, '.work', 'kit-2-x'),
    dir: join(repo, '.work', 'kit-2-x', '.local', 'build-feature'),
    runId: 'run-test',
    now: '2026-10-15T00:00:00.000Z',
    aspira: { repository: 'aspiralabs/kit', app: '.' },
    card: { id: ID, title: TITLE, url: 'https://app.notion.com/p/kit-2-x', status: 'In Progress: Implementation', pr: null, dev: null, type: 'Feature' },
    resume: '/aspira-build-feature KIT-2 --local',
    env,
    mode: 'local',
  }
}

/** Already committed and already pushed at this HEAD, so the phase goes straight to the PR step without a real push. */
function stateAt(head: string): RunState {
  return { ...emptyRunState(), step8: { pushed: true, prUrl: null, prPropertySet: false, moved: false }, phases: { step8: { committedFor: null, commit: null, pushedHead: head } } }
}

describe('T32 F24: Step 8 never reuses or sets a fork PR, even when its branch name matches', () => {
  it('stops naming headRepository instead of reusing the fork PR gh pr list returns', async () => {
    const { repo, env, head } = await repoOnTicketBranch()
    const context = contextFor(repo, env)
    const result = await step8Phase.next(context, stateAt(head))
    expect({ kind: result.kind, namesHeadRepository: result.kind === 'stop' && /headRepository/.test(result.message) }).toEqual({ kind: 'stop', namesHeadRepository: true })
  })
})
