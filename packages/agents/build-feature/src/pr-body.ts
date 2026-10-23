// The PR body: `.work/<id>-<slug>/.local/build-feature/pr-body.md` (every stop, driver.ts's
// writeSummary) and `.work/<id>-<slug>/.local/build-feature/pr-body.md` for `gh pr create
// --body-file`/`gh pr edit` (step8.ts). An adapter over agent-common's shared renderer (F3, F42,
// F43, KIT-2 P22): reads the implementor's `plan.review/implementation.md` from the ticket folder
// (when one is given; a stop before the implementor has run has none, and the body then has empty
// Summary/Evidence/Merge Danger sections, same as today's decisions-only body) and the branch's
// changed files (`git diff --name-only` against the base branch, repo-local, never thrown on
// failure), then passes the decisions taken after Ready: Plan and the same-session or cloud notice,
// in the same order summary.ts uses. Untrusted fragments (a decision's question and answer) are
// redacted inside the shared renderer, scoped to `app`.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { renderPrBody as renderSharedPrBody } from '@aspiralabs/agent-common/lib/pr-body'
import { orderedTaken } from '#src/decisions.ts'
import type { RunState } from '#src/run-state.ts'
import { visualVerifyRecordOf } from '#src/visual-verify.ts'

const exec = promisify(execFile)

/** The branch every PR targets (step8.ts's own BASE_BRANCH): not imported from there to avoid a
 * circular import (step8.ts imports `renderPrBody` from this module). */
const BASE_BRANCH = 'main'

export type PrBodyTicket = { id: string; title: string; url: string }
export type RenderPrBodyInput = {
  ticket: PrBodyTicket
  state: RunState
  repo: string
  /** The ticket's working folder (`.work/<id>-<slug>/`), to read `plan.review/implementation.md` from. Omitted before the implementor has a folder to read; the body then has no Evidence. */
  folder?: string
  /** The app directory (aspira.json `app`), to scope redaction; also the one app whose `.static-analysis/rounds.json` is read when `apps` is not given. */
  app?: string
  /** The app directories the code-analyzer ran on (KIT-39), each with its own `.static-analysis/rounds.json`. Default: `app` alone. */
  apps?: string[]
}

const SAME_SESSION_NOTICE = "This build's steps and its reviews all ran in the same session: no separate review pass followed."
const CLOUD_NOTICE = "This build's steps and its reviews each ran as that step's own agent run (cloud mode), not in one session."

/** `git diff --name-only` against the base branch; `[]` on any failure (no commits yet, no base branch, a bare repository), never thrown. */
async function changedFiles(repo: string): Promise<string[]> {
  const base = await exec('git', ['merge-base', BASE_BRANCH, 'HEAD'], { cwd: repo })
    .then((result) => result.stdout.trim())
    .catch(() => null)
  if (base === null) return []
  const diff = await exec('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repo })
    .then((result) => result.stdout)
    .catch(() => '')
  return diff.split('\n').filter((line) => line.trim() !== '')
}

/** The one app's code-analyzer result, from its `.static-analysis/rounds.json`; `[]` when there is no app, no file, or it does not parse. */
async function analyzerOf(repo: string, app: string | undefined): Promise<{ app: string; status: string; reasonCode?: string | null }[]> {
  if (app === undefined) return []
  const text = await readFile(join(repo, app, '.static-analysis', 'rounds.json'), 'utf8').catch(() => null)
  if (text === null) return []
  try {
    const parsed = JSON.parse(text) as { status?: unknown; reasonCode?: unknown }
    const status = typeof parsed.status === 'string' ? parsed.status : 'unknown'
    const reasonCode = typeof parsed.reasonCode === 'string' ? parsed.reasonCode : null
    return [{ app, status, reasonCode }]
  } catch {
    return []
  }
}

/** The PR body for this run state: Summary, Evidence and Merge Danger (from `folder`'s implementation.md and the branch diff, when `folder` is given), then the decisions taken for you after Ready: Plan, the run-mode notice, and a link to the Build Summary. */
export async function renderPrBody(input: RenderPrBodyInput): Promise<string> {
  const { ticket, state, repo, folder, app, apps } = input
  const implementationMd = folder === undefined ? '' : await readFile(join(folder, 'plan.review/implementation.md'), 'utf8').catch(() => '')
  const [changed, ...results] = await Promise.all([changedFiles(repo), ...(apps ?? [app]).map((dir) => analyzerOf(repo, dir))])
  const analyzers = results.flat()
  const taken = orderedTaken(state.takenKeys).map((entry) => ({ key: entry.key, decision: { question: entry.decision.question, answer: entry.decision.answer, recommended: entry.decision.recommended } }))
  const notice = (state.runs.at(-1)?.mode ?? 'local') === 'local' ? SAME_SESSION_NOTICE : CLOUD_NOTICE
  const visualVerify = visualVerifyRecordOf(state)
  const footer = `See this ticket's **Build Summary** page for the full report: ${ticket.url}`
  return renderSharedPrBody({ ticket, implementationMd, changedFiles: changed, analyzers, taken, notice, footer, repo, ...(visualVerify === null ? {} : { visualVerify }), ...(app === undefined ? {} : { app }) })
}
