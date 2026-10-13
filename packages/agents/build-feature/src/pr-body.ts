// The PR body: `.work/<id>-<slug>/.local/build-feature/pr-body.md`, passed to `gh pr create
// --body-file` and rewritten with `gh pr edit` after a fix push and at the end of the run
// (playbook.ts:111-113). It lists the decisions taken after Ready: Plan first (the implementor's
// assumptions and the Step 9 fix subagent's own decisions, in the same order summary.ts uses), then
// the same-session review notice, then a link to the ticket's Build Summary. Untrusted fragments
// (a decision's question and answer) are redacted one at a time, the same way summary.ts does, so
// the composed markdown itself is never redacted whole.

import { orderedTaken } from '#src/decisions.ts'
import { redact } from '#src/redact.ts'
import type { RunState } from '#src/run-state.ts'

export type PrBodyTicket = { id: string; title: string; url: string }
export type RenderPrBodyInput = { ticket: PrBodyTicket; state: RunState; repo: string }

const SAME_SESSION_NOTICE = "This build's steps and its reviews all ran in the same session: no separate review pass followed."

/** The PR body for this run state: the decisions taken after Ready: Plan first, then the same-session notice, then a link to the Build Summary. */
export async function renderPrBody(input: RenderPrBodyInput): Promise<string> {
  const { ticket, state, repo } = input
  const taken = orderedTaken(state.takenKeys)
  const lines: string[] = []
  if (taken.length === 0) lines.push('No decisions were taken for you after Ready: Plan in this build.')
  else {
    lines.push('## Decisions taken for you', '')
    for (const entry of taken) {
      const question = await redact(entry.decision.question, repo)
      const answer = await redact(entry.decision.answer ?? entry.decision.recommended, repo)
      lines.push(`- \`${entry.key}\`: ${question} Taken: ${answer}.`)
    }
  }
  lines.push('', SAME_SESSION_NOTICE, '', `See this ticket's **Build Summary** page for the full report: ${ticket.url}`)
  return `${lines.join('\n')}\n`
}
