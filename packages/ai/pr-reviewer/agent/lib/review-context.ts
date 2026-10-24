// The review context as pr-debator's workflow body and the seats' system prompt both read it,
// pure: no Node.js builtin, because the workflow body imports this. The file it comes from is
// shared-prefix.ts's business.

import { maxSeatCalls } from './call-cap.ts'
import type { PrContext, Reviewer } from './review.ts'
import type { ReviewContextFile } from './target.ts'

/** The PrContext every prompt is built from, the same on both paths, so the bytes are the same. */
export function prContextFrom(context: ReviewContextFile, env: Record<string, string | undefined> = process.env): PrContext {
  return {
    label: context.pr.label,
    repoPath: context.pr.repoPath,
    knowledgePath: context.pr.knowledgePath,
    knowledgeRequiredFile: context.pr.knowledgeRequiredFile,
    packet: context.packet,
    target: context.target,
    maxSeatCalls: maxSeatCalls(env),
  }
}

/** The persona of a reviewer, as load-pr read it from agent/subagents/<who>/persona.md. */
export const personaOf = (context: ReviewContextFile, who: Reviewer): string => context.personas[who]
