// Pure helpers for the pr-debator workflow. No eve imports, no side effects, so
// the seats, prompts, schemas, and the verdict can be tested without a runtime.

import { z } from 'zod'
import { SEVERITIES, WHAT_THIS_MEANS_RULE, type Counts, type Severity } from '@aspiralabs/agent-common/lib/severity'
import { DEFAULT_MAX_SEAT_CALLS } from './call-cap.ts'
import { reviewedLine, type ReviewTarget } from './target.ts'

/** The sandbox files every seat reads or writes, at the agent's paths. */
export const FILES = {
  meta: '/workspace/pr.md',
  patch: '/workspace/pr.patch',
  changed: '/workspace/changed_files.txt',
  conversation: '/workspace/conversation.md',
  findings: '/workspace/findings.md',
  review: '/workspace/review.md',
  /** A re-review: the previous review's findings.md, verbatim. */
  previousFindings: '/workspace/previous-findings.md',
} as const

/** Where load-pr checks out the tree in the sandbox. */
export const REPO_PATH = '/workspace/repo'
/** Where every seat writes its round files in the sandbox. */
export const ROUNDS_DIR = '/workspace/review'
/** The sandbox root the agent's paths hang off. */
export const WORKSPACE_ROOT = '/workspace'

/**
 * The paths the prompts name. The agent's sandbox layout by default; `--local` maps
 * them to a work directory on the host so the same prompt functions produce its prompts.
 */
export type WorkspacePaths = { files: Record<keyof typeof FILES, string>; roundsDir: string }

/** The agent's own layout: what every prompt says when no paths are given. */
export const SANDBOX_PATHS: WorkspacePaths = { files: FILES, roundsDir: ROUNDS_DIR }

/** The sandbox layout rehomed under `root`: `/workspace/pr.patch` becomes `<root>/pr.patch`. */
export function workspacePaths(root: string): WorkspacePaths {
  const files = {
    meta: rehome(FILES.meta, root),
    patch: rehome(FILES.patch, root),
    changed: rehome(FILES.changed, root),
    conversation: rehome(FILES.conversation, root),
    findings: rehome(FILES.findings, root),
    review: rehome(FILES.review, root),
    previousFindings: rehome(FILES.previousFindings, root),
  }
  return { files, roundsDir: rehome(ROUNDS_DIR, root) }
}

/** One sandbox path rehomed under `root`. Paths outside the sandbox are returned unchanged. */
export function rehome(path: string, root: string): string {
  return path.startsWith(`${WORKSPACE_ROOT}/`) ? `${root.replace(/\/+$/, '')}${path.slice(WORKSPACE_ROOT.length)}` : path
}

/** A round's directory under `roundsDir` (the sandbox's by default). */
export const roundDir = (round: number, roundsDir: string = ROUNDS_DIR) => `${roundsDir}/round-${round}`
/** One reviewer's file for one round. */
export const roundFile = (round: number, who: Reviewer, roundsDir: string = ROUNDS_DIR) => `${roundDir(round, roundsDir)}/${who}.md`

/** The six lenses. Ported from nitpick's reviewer roles, plus a design-system seat. */
export type Seat = 'ava' | 'cole' | 'nova' | 'reba' | 'dex' | 'iris'
/** Quinn verifies; Quinn never raises findings. */
export type Reviewer = Seat | 'quinn'

export const SEATS: readonly Seat[] = ['ava', 'cole', 'nova', 'reba', 'dex', 'iris'] as const

export const DISPLAY_NAME: Record<Reviewer, string> = {
  ava: 'Ava',
  cole: 'Cole',
  nova: 'Nova',
  reba: 'Reba',
  dex: 'Dex',
  iris: 'Iris',
  quinn: 'Quinn',
}

export const LENS: Record<Seat, string> = {
  ava: 'security',
  cole: 'performance',
  nova: 'architecture',
  reba: 'testing',
  dex: 'developer experience',
  iris: 'design system',
}

/** Finding id prefixes. Stable across rounds, so a ruling can name one. */
export const PREFIX: Record<Seat, string> = {
  ava: 'AVA',
  cole: 'COLE',
  nova: 'NOVA',
  reba: 'REBA',
  dex: 'DEX',
  iris: 'IRIS',
}

// Seven model calls a round, so the cap is lower than spec-debator's.
export const DEFAULT_MAX_ROUNDS = 4
export const MAX_ROUNDS_LIMIT = 10

/** The one severity order every Aspira agent uses, from agent-common. */
export { SEVERITIES, type Counts, type Severity }

export const EMPTY_COUNTS: Counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }

export type Verdict = 'block' | 'comment' | 'approve'

/**
 * The verdict is arithmetic, not an opinion: the workflow computes it from the
 * counts the fix list reports, so no model can talk itself into "approve".
 */
export function verdictFrom(counts: Counts): Verdict {
  if (counts.critical > 0 || counts.high > 0) return 'block'
  if (counts.medium > 0 || counts.low > 0) return 'comment'
  return 'approve'
}

export function totalFindings(counts: Counts): number {
  return SEVERITIES.reduce((sum, severity) => sum + (counts[severity] ?? 0), 0)
}

/** What every review turn must return. The workflow, not the seats, decides when the review ends. */
export const TURN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    agreed: {
      type: 'boolean',
      description:
        'true once every finding you raised has a ruling from Quinn (confirmed, adjusted, rejected or duplicate) and you are disputing none of them. Whether the author has fixed anything does not matter; a ruled-on finding is settled. false while a finding of yours has no ruling yet or you are disputing one.',
    },
    raised: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of the findings you raised this turn, exactly as written in your round file. Empty when you raised none.',
    },
    disputed: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of the Quinn rulings you disputed this turn. Empty when you accepted every ruling on your findings.',
    },
    openPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Finding ids still disputed or unanswered, each with a one-line summary. Empty when agreed.',
    },
    note: { type: 'string', description: 'One sentence on where the review stands from your seat.' },
  },
  required: ['agreed', 'raised', 'disputed', 'openPoints', 'note'],
  additionalProperties: false,
} as const

/** What Quinn's verification turn must return. */
export const VERIFY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    agreed: {
      type: 'boolean',
      description: 'true only if every finding now has a settled ruling and no seat is still disputing one.',
    },
    openPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Finding ids still contested after your rulings, each with a one-line summary.',
    },
    rejected: { type: 'array', items: { type: 'string' }, description: 'Ids you rejected this round.' },
    duplicates: { type: 'array', items: { type: 'string' }, description: 'Ids folded into another finding this round.' },
    note: { type: 'string', description: 'One sentence on the state of the finding list.' },
  },
  required: ['agreed', 'openPoints', 'rejected', 'duplicates', 'note'],
  additionalProperties: false,
} as const

/** What a document-writing or document-review turn must return. */
export const DOC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'The workspace path you wrote.' },
    changed: { type: 'boolean', description: 'Review turns: whether you changed the document.' },
    note: { type: 'string', description: 'One sentence on what you wrote or changed.' },
  },
  required: ['path', 'changed', 'note'],
  additionalProperties: false,
} as const

/** The fix list writer also reports the counts the verdict is computed from. */
export const FINDINGS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'The workspace path you wrote.' },
    changed: { type: 'boolean', description: 'Always true when you wrote the file.' },
    note: { type: 'string', description: 'One sentence on what the fix list says.' },
    counts: {
      type: 'object',
      description: 'How many findings you wrote at each severity. Count only findings that survived verification.',
      properties: {
        critical: { type: 'number' },
        high: { type: 'number' },
        medium: { type: 'number' },
        low: { type: 'number' },
        info: { type: 'number' },
      },
      required: ['critical', 'high', 'medium', 'low', 'info'],
      additionalProperties: false,
    },
  },
  required: ['path', 'changed', 'note', 'counts'],
  additionalProperties: false,
} as const

export type TurnOutput = { agreed: boolean; raised: string[]; disputed: string[]; openPoints: string[]; note: string }
export type VerifyOutput = { agreed: boolean; openPoints: string[]; note: string; rejected: string[]; duplicates: string[] }
export type DocOutput = { path: string; changed: boolean; note: string }
export type FindingsOutput = DocOutput & { counts: Counts }

const countsShape = z.strictObject({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number(), info: z.number() })

/**
 * Validators for the four structured results, for callers outside eve (`--local`). They
 * describe exactly the JSON schemas above; review.test.ts fails if the two drift apart.
 */
export const OUTPUT_VALIDATORS: {
  turn: z.ZodType<TurnOutput>
  verify: z.ZodType<VerifyOutput>
  doc: z.ZodType<DocOutput>
  findings: z.ZodType<FindingsOutput>
} = {
  turn: z.strictObject({ agreed: z.boolean(), raised: z.array(z.string()), disputed: z.array(z.string()), openPoints: z.array(z.string()), note: z.string() }),
  verify: z.strictObject({
    agreed: z.boolean(),
    openPoints: z.array(z.string()),
    rejected: z.array(z.string()),
    duplicates: z.array(z.string()),
    note: z.string(),
  }),
  doc: z.strictObject({ path: z.string(), changed: z.boolean(), note: z.string() }),
  findings: z.strictObject({ path: z.string(), changed: z.boolean(), note: z.string(), counts: countsShape }),
}

/** The JSON schema each validator mirrors, by the same key. */
export const OUTPUT_SCHEMAS = {
  turn: TURN_OUTPUT_SCHEMA,
  verify: VERIFY_OUTPUT_SCHEMA,
  doc: DOC_OUTPUT_SCHEMA,
  findings: FINDINGS_OUTPUT_SCHEMA,
} as const

/** Which structured result a turn returns. */
export type OutputKind = keyof typeof OUTPUT_SCHEMAS

/**
 * The stopping rule, shared by pr-debator and the --local driver. A round in which no seat
 * disputed a ruling and no seat raised a finding has nothing left to argue: the review ends.
 * Round 1 with findings is never settled (they have no ruling to answer yet), so round 2 runs
 * for the seats to accept or dispute Quinn's rulings; a dispute buys one more round.
 */
export function roundSettled(seats: readonly TurnOutput[]): boolean {
  return seats.every((seat) => seat.raised.length === 0 && seat.disputed.length === 0)
}

/** Whether the review is agreed: it settled, or every seat and Quinn said so in the last round. */
export function reviewAgreed(seats: readonly TurnOutput[], quinn: VerifyOutput, settled: boolean): boolean {
  return settled || (seats.every((seat) => seat.agreed) && quinn.agreed)
}

export type PrContext = {
  /** Human label for the transcript header: `owner/name#123` or a local path with its base ref. */
  label: string
  /** Sandbox path of the checked-out tree, or null when only a patch was given. */
  repoPath: string | null
  /** Sandbox path of the engineering guidelines from load-knowledge, or null when not loaded. */
  knowledgePath?: string | null
  /** REQUIRED.md from load-knowledge: the pages every seat reads in full, first. */
  knowledgeRequiredFile?: string | null
  /** Where the prompts say the files are. The sandbox layout when absent. */
  paths?: WorkspacePaths
  /** The review packet (the index), built once by load-pr: the first thing in every prompt. Null when none was built. */
  packet?: string | null
  /** The shas the verdict applies to, and the previous head for a re-review. */
  target?: ReviewTarget | null
  /** Tool calls a seat may make per round. DEFAULT_MAX_SEAT_CALLS when absent. */
  maxSeatCalls?: number
}

const pathsOf = (pr: PrContext): WorkspacePaths => pr.paths ?? SANDBOX_PATHS
const sinceOf = (pr: PrContext) => pr.target?.since ?? null
const capOf = (pr: PrContext) => pr.maxSeatCalls ?? DEFAULT_MAX_SEAT_CALLS

/** The packet, verbatim, first: every call that carries it shares the prefix. */
const packetSection = (pr: PrContext) => (pr.packet === undefined || pr.packet === null ? '' : `${pr.packet}\n\n---\n\n`)

const knowledgeSection = (pr: PrContext) =>
  pr.knowledgePath === undefined || pr.knowledgePath === null
    ? ''
    : `

${pr.knowledgeRequiredFile === undefined || pr.knowledgeRequiredFile === null ? '' : `Required reading is ${pr.knowledgeRequiredFile}: the pages every reviewer must ingest in full.${pr.packet === undefined || pr.packet === null ? ` Your first command is \`cat ${pr.knowledgeRequiredFile}\`.` : ' It is in the packet above under "Required reading"; do not read the file again.'} Read every line; never pipe a knowledge file through \`head\` or grep it for headings. A rule there that names a check is a step you run before writing a finding. `}The org's engineering guidelines are at ${pr.knowledgePath}, indexed in ${pr.knowledgePath}/INDEX.md. Read the pages that cover what this diff touches. A guideline is a rule, not a preference: a change that contradicts one is a finding at the severity the guideline implies, citing the file. Where the guidelines are silent, review on the merits as usual. Cite guideline files; do not quote them at length.`

const repoSection = (pr: PrContext) =>
  pr.repoPath === null
    ? `There is no checked-out tree for this review — you have the diff and nothing else. Review the patch alone. Do not guess at code you cannot see: if a finding depends on how something outside the diff behaves, say that the finding is conditional and on what.`
    : `The repository is checked out at ${pr.repoPath}. The diff shows what changed; the tree shows what it changed *into*, and a diff read without its surroundings produces confident nonsense. Do not modify the tree and do not run the project.`

const readRules = (pr: PrContext) => {
  const cap = capOf(pr)
  const packet = pr.packet === undefined || pr.packet === null
  return `Reading, all seats:

- ${packet ? `Read ${pathsOf(pr).files.patch} and the changed files first.` : 'The packet above is an index of the change, not the change: one line per changed file with its area and the symbols its hunks touch. Choose by your lens. A security seat picks the api, db-migration and infra lines and whatever touches auth or input; a design-system seat picks web-ui and mobile; a testing seat picks test and e2e beside the code they cover. Then fetch the hunks of exactly those files with one `read_diff(paths)` call, and the surrounding code you need (what a changed file calls, who calls it, the test beside it) with one `read_files(paths)` call. Do not fetch what you will not review. Cite paths and lines from what you fetched, never from the index alone.'}
- \`search(pattern, globs?)\` finds definitions and callers, with two lines of context. \`read_file\` is for a one-off. Searching with \`rg\` or \`grep -rn\` in a shell counts as a call too. Decide everything you need before you fetch: one batch each, not a call per file.
- You have at most ${cap} tool calls this round. At the cap, stop reading: write your round file with what you have and list every path you wanted and did not read under a \`### Not read\` heading.`
}

const sinceSection = (pr: PrContext) => {
  const since = sinceOf(pr)
  if (since === null || pr.target === undefined || pr.target === null) return ''
  return `

This is a re-review. The previous review of this change, in ${since.dir}, was of head \`${since.sha}\`; the head is now \`${pr.target.headSha}\`, and the diff is only what changed between the two. Its findings are in ${pathsOf(pr).files.previousFindings}${pr.packet === undefined || pr.packet === null ? '' : ' and in the packet above under "Previous findings"'}. You do two things, and nothing else: for each previous finding, say whether the new diff fixes it, with the line that fixes it as evidence, or leaves it open; and raise new findings only on the delta. Code the delta does not touch is out of scope, previous findings included — a previous finding on code this delta leaves alone is simply still open.`
}

const context = (pr: PrContext) => `What you are reviewing, in the sandbox:

- ${pathsOf(pr).files.meta} — the pull request: title, description, base and head.
- ${pathsOf(pr).files.patch} — the unified diff. This is the change. Everything you flag lives in here.
- ${pathsOf(pr).files.changed} — the changed paths, one per line.

${repoSection(pr)}${knowledgeSection(pr)}${sinceSection(pr)}

${readRules(pr)}`

const findingRules = (pr: PrContext) => {
  const { files } = pathsOf(pr)
  const scope = sinceOf(pr) === null ? 'Review only what the diff changes. A finding about code the diff does not touch is out of scope and Quinn will reject it.' : 'Review only what the delta changes. A new finding about code the delta does not touch is out of scope and Quinn will reject it; a previous finding is answered, not re-raised.'
  return `Finding rules, all seats:

- ${scope}
- Every finding cites a path from ${files.changed} and a line or line range, and quotes the evidence from the diff.
- Copy paths from ${files.changed} or ${files.patch}. Never assemble one from memory of how the project is probably laid out: \`components/ui/core/alert.tsx\` and \`components/ui/core/alert/alert.tsx\` are different files, and only one of them exists. If a read says a path is not there, the path was wrong — find the real one with \`search\` before you write anything about it.
- Severity is one of \`critical\`, \`high\`, \`medium\`, \`low\`, \`info\`. Confidence is a number from 0 to 1. Both are yours to defend.
- Every finding opens with **What this means:** ${WHAT_THIS_MEANS_RULE}. The evidence and the fix stay exact and technical; the plain-English line is what the author reads first.
- Prefer the exploitable, reachable, and concrete over the theoretical. Three real findings beat ten vague ones.
- Do not spend a finding on what typecheck, lint, or prettier already catches. Those gates run before you do.
- Nothing to say is a result. Write "None." and mean it.`
}

const previousShape = (pr: PrContext) =>
  sinceOf(pr) === null
    ? ''
    : `### Previous findings
One line per finding in the previous fix list, every one of them: \`[ID] fixed — <path>:<line>, what the delta does\`, \`[ID] still open — why\`, or \`[ID] withdrawn — why it no longer applies\`. Only the lenses you own; "not my lens" for the rest.

`

const sectionShape = (who: Seat, round: number, pr: PrContext) => `## Round ${round} — ${DISPLAY_NAME[who]} (${LENS[who]})

${previousShape(pr)}### Responses
One line per open finding from another seat that touches your lens, and one line per ruling Quinn made on *your* findings: \`[ID] accept\`, \`[ID] withdraw — reason\`, or \`[ID] dispute — evidence from the diff or the tree\`. Disputing Quinn is allowed when you have evidence; saying nothing is not. Skip this heading in round 1.

### Findings
Your new findings, each as:

\`#### [${PREFIX[who]}${round}.1] <severity> · <category> · <path>:<line-or-range> · confidence <0.0-1.0>\`

then four short blocks, in this order: \`**What this means:**\` (the plain-English line, as the finding rules say), what is wrong, the evidence quoted from the diff, and the fix. Write "None." if you have none.

### Position
One short paragraph: what you now believe must change in this PR, across every point that was ever raised in your lens.

### Status
\`agreed\` or \`open\`, followed by the ids still open. A ruled-on finding is closed whether or not anyone has fixed it; do not list it.

### Not read
Only when you hit the call cap: the paths you wanted and did not read. Omit the heading otherwise.`

const protocol = (who: Seat, round: number, pr: PrContext) => {
  const { files, roundsDir } = pathsOf(pr)
  const packet = pr.packet !== undefined && pr.packet !== null
  return `Protocol, every turn:

1. ${packet ? `The packet above is ${files.meta} and the index of ${files.changed}; the hunks of ${files.patch} come one batch at a time through \`read_diff\`, for the files you chose.` : `Read ${files.meta}, ${files.patch}, and ${files.changed} in full.`} ${round === 1 ? 'Round 1 has no record yet.' : `Then read every file under ${roundsDir}/ — every seat's rounds and every one of Quinn's verification files — in one \`read_files\` call. Do not rely on memory; the files are the record. \`find ${roundsDir} -type f | sort\` lists them.`}
2. Write ${roundFile(round, who, roundsDir)}. One file, yours alone, this round only. Never edit another seat's file and never edit your own earlier rounds. The shape:

${sectionShape(who, round, pr)}

3. Return the structured result. \`raised\` is the ids you wrote under Findings this turn; \`disputed\` is the ids of the rulings you disputed. \`agreed\` is true once every finding you ever raised has a ruling and you dispute none of them. The review ends after a round in which no seat raised or disputed anything, so do not hold out for fixes: a ruled-on finding is settled.`
}

/**
 * The shared prefix: the packet, then every instruction that is the same for every seat and for
 * Quinn in every round. On the eve path it is the whole system prompt of each seat session
 * (agent/lib/shared-prefix-instructions.ts), and on --local the first bytes of every prompt file,
 * so all seven sessions of a round send one identical block before anything of their own: the
 * persona, then the turn. One identical block is one cache prefix; six different ones are six.
 */
export function sharedPrefix(pr: PrContext): string {
  return `${packetSection(pr)}# Review instructions, every seat

These instructions are the same for every seat and for Quinn, in every round. Who you are and what this turn asks for come after them.

${context(pr)}

${findingRules(pr)}`
}

/** What separates the shared prefix, the persona and the turn in a prompt. */
export const PROMPT_SEPARATOR = '\n\n---\n\n'

/** The message a seat session receives on the eve path: its persona, then the turn. The shared prefix is its system prompt. */
export function turnMessage(persona: string, turn: string): string {
  return `${persona.trim()}${PROMPT_SEPARATOR}${turn}`
}

/** The whole prompt as one text, in the order every seat shares: prefix, persona, turn. --local writes exactly this. */
export function fullPrompt(pr: PrContext, persona: string, turn: string): string {
  return `${sharedPrefix(pr)}${PROMPT_SEPARATOR}${turnMessage(persona, turn)}`
}

/** Round 1 for a seat: what this turn asks for. The packet and the shared rules are in the prefix. */
export function openingPrompt(who: Seat, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}, the ${LENS[who]} seat. This is round 1 of a review of ${pr.label}. Five other seats are reviewing the same diff in parallel through their own lenses, and Quinn verifies all of it after every round. You do not know which model any of them is. Do not defer to them. The packet and the review instructions above apply to you in full.

${protocol(who, 1, pr)}`
}

export function turnPrompt(who: Seat, round: number, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}, the ${LENS[who]} seat, in round ${round} of the review of ${pr.label}. Every other seat has written since you last read the record, and Quinn has ruled on round ${round - 1}. Answer every ruling on your findings: accept it, or dispute it with evidence. If you accept them all and have nothing new, say so and mark \`agreed\`; the review ends when every seat does. The packet and the review instructions above apply to you in full.

${protocol(who, round, pr)}`
}

export function verifyPrompt(round: number, pr: PrContext): string {
  const { roundsDir } = pathsOf(pr)
  const packet = pr.packet !== undefined && pr.packet !== null
  const since = sinceOf(pr)
  const previous =
    since === null
      ? ''
      : `
- This is a re-review of \`${since.sha}\`..\`${pr.target?.headSha ?? ''}\`. Rule on each seat's answer to each previous finding too: \`[ID] fixed — confirmed\` when the line it cites is in the delta and does what the seat says, else \`[ID] still open\`. REJECT a new finding on code the delta does not change, as always.`
  return `You are Quinn, the verification seat for the review of ${pr.label}. You are independent of the six reviewers twice over: they hunt and you check, and you run on a different model family than any of them. You raise no findings of your own. Your job is to keep the list honest. The packet and the review instructions above apply to you in full; the finding rules there are what you hold the seats to.

Read every file under ${roundsDir}/ — all seats, all rounds including your own earlier rulings — in one \`read_files\` call. For every finding that is still open, check the actual code at the path and lines it cites and cross-reference it against the diff: fetch the hunks of the cited files, and only those, with one \`read_diff\` call, and the cited code at HEAD with one \`read_files\` call, before you write.${packet ? ' The packet above is the index, not the diff; a finding on a path the index does not list is on code the diff does not change.' : ''}

Write ${roundFile(round, 'quinn', roundsDir)}:

## Round ${round} — Quinn (verification)

### Rulings
One line per open finding id, in this shape:

\`[ID] confirmed — note\`
\`[ID] adjusted severity <old> → <new> — note\` (or \`confidence <old> → <new>\`)
\`[ID] rejected — note\`
\`[ID] duplicate of [OTHER-ID] — note\`

Rules for rulings:

- REJECT a finding that references code the diff does not change.
- REJECT a finding whose described problem does not exist when you read the actual code.
- ADJUST severity down when the impact is overstated in context, up when it is worse than described.
- ADJUST confidence down when the evidence is weak or speculative, up when the code confirms it more strongly than the seat claimed.
- Mark DUPLICATE when two findings share a root cause in the same place and one fix closes both, even if the titles, categories, or severities differ. Name the id that survives — the most accurate description, then the highest confidence, then the highest severity. Do not fold together findings that merely touch the same file.
- When in doubt between confirming and rejecting, lean towards confirming.
- **A failed read is not evidence against a finding.** If a read cannot open the path a finding cites, the citation may be wrong while the finding is right. Locate the real file first with \`search\` and rule on the code. Reject for a bad path only after you have looked and the code is not there under any name. Never spend two calls on a path that has already failed once.
- A seat may dispute your ruling with evidence. Read the dispute and rule again; change your mind when the evidence is better than yours, and say so. Do not hold a ruling out of consistency.${previous}

### Standing
The current list: every surviving finding id with its final severity, grouped by severity, highest first. Then one line per finding still contested and who is contesting it.

Return the structured result. \`agreed\` is true only when every finding has a settled ruling that no seat is still disputing.`
}

/** The line the writers put under the title; export stamps it in whether or not they did. */
const reviewedSection = (pr: PrContext) => (pr.target === undefined || pr.target === null ? '' : ` Then, as its own line right under the title: \`${reviewedLine(pr.target)}\`.`)

export function writeFindingsPrompt(pr: PrContext, agreed: boolean): string {
  const unresolved = agreed
    ? ''
    : `\n\nThe review hit its round cap without full agreement. End the file with \`## Unresolved\`: one entry per finding still contested, both positions stated plainly, and what a human has to decide. Do not pick a side and do not count these in \`counts\`.`
  const { files, roundsDir } = pathsOf(pr)
  const since = sinceOf(pr)
  const shape =
    since === null
      ? `\`# Findings: ${pr.label}\`,${reviewedSection(pr)} then exactly one totals line in this form: \`Totals: <n> critical · <n> high · <n> medium · <n> low · <n> info\`, then \`## Critical\` / \`## High\` / \`## Medium\` / \`## Low\` / \`## Info\` — skip a heading with nothing under it. Under each, one \`### [ID] <one-line title>\` per finding with, in this order: a \`**What this means:**\` line (${WHAT_THIS_MEANS_RULE}), then location as \`path:line\`, what is wrong, the evidence quoted from the diff, the fix, who raised it, and Quinn's ruling in a few words.`
      : `\`# Findings: ${pr.label}\`,${reviewedSection(pr)} then exactly one totals line in this form: \`Totals: <n> critical · <n> high · <n> medium · <n> low · <n> info\` counting the still-open previous findings and the new ones together. Then \`## Previous findings\`: a table with one row per finding of the previous fix list (${files.previousFindings}), columns ID, severity, state (\`fixed\`, \`still open\`, \`withdrawn\`) and evidence (\`path:line\` for fixed, the reason otherwise), as Quinn ruled them. Then \`## New findings\`: one line saying how many, and \`None.\` when there are none. Then \`## Critical\` / \`## High\` / \`## Medium\` / \`## Low\` / \`## Info\` — skip a heading with nothing under it — holding the still-open previous findings, each marked \`(previous, still open)\`, and the new findings, each marked \`(new)\`, one \`### [ID] <one-line title>\` per finding with, in this order: a \`**What this means:**\` line (${WHAT_THIS_MEANS_RULE}), then location as \`path:line\`, what is wrong, the evidence quoted from the diff, the fix, who raised it, and Quinn's ruling in a few words. Fixed and withdrawn findings appear only in the table.`
  return `You are Nova. The review of ${pr.label} is over. Write the fix list.

Read every file under ${roundsDir}/ in full${pr.packet === undefined || pr.packet === null ? ` and ${files.patch} and ${files.changed}` : ' (one `read_files` call; the index of the change is in the packet above, and the hunks of the files the findings cite come from one `read_diff` call)'}, then write ${files.findings}: what this PR has to fix, settled, deduplicated, in severity order.

Shape:

${shape}

Rules:

- Only findings that survived verification. Nothing Quinn rejected, nothing Quinn folded into another id, nothing a seat withdrew.
- Keep the id and the severity as they finally stood, not as first written. Where Quinn adjusted severity, use the adjusted one.
- One entry per real problem. If two surviving ids describe one fix, Quinn missed a duplicate — merge them and say so in the entry.
- No praise, no summary of the debate, no hedging. This is a work list.
- Every finding that survived is in the file, under its severity: the totals line counts exactly the entries below it, and nothing is folded into a summary.
- Do not write a verdict line. The verdict is computed from your counts, not asserted.${unresolved}

Return the structured result with the path, \`changed: true\`, and \`counts\`: how many findings you actually wrote at each severity.`
}

export function writeReviewPrompt(pr: PrContext, agreed: boolean): string {
  const unresolved = agreed ? '' : ` Say plainly that the seats did not settle everything, and name what is still open in one line each.`
  const { files, roundsDir } = pathsOf(pr)
  const since = sinceOf(pr)
  const again = since === null ? '' : ` Say in the first sentence that this was a re-review of \`${since.sha}\`..\`${pr.target?.headSha ?? ''}\`, and add \`## Previous findings\` before the fix sections: one line per previous finding, fixed, still open or withdrawn.`
  return `You are Dex. The review of ${pr.label} is over. Write the summary the author reads first.

Read every file under ${roundsDir}/ in full${pr.packet === undefined || pr.packet === null ? ` and ${files.meta} and ${files.patch}` : ' (one `read_files` call; the pull request and the index of the change are in the packet above, and the hunks of the files the findings cite come from one `read_diff` call)'}, then write ${files.review}: plain English, for the person who opened this PR and will not read the transcript.

Sections:

- \`# Review: ${pr.label}\`${reviewedSection(pr)}
- \`## What this change does\` — two to four sentences, from the diff, not from the PR description.${again}
- \`## Fix before merge\` — the critical findings, then the high ones, one bullet each, in the author's words: the plain-English line first (what a user or the team would see go wrong), then where, and what to do. No ids in the sentence; put the id in brackets at the end. One line saying "nothing" if there is nothing.
- \`## Worth fixing\` — medium, then low, then info, same shape, every one of them. One line saying "nothing" if there is nothing.
- \`## Checked and clean\` — what the seats looked at and found nothing wrong with, one line per lens. This is what makes the rest trustworthy.${unresolved}

No praise for the author, no praise for the seats, no filler, no hedging. If the change is good, say it in one sentence and move on.

Return the structured result with the path and \`changed: true\`.`
}

export function reviewDocPrompt(who: Reviewer, path: string, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}. ${path} has been written for the review of ${pr.label}.

Read every file under ${pathsOf(pr).roundsDir}/ in one \`read_files\` call, and then ${path}. Check it against the record: nothing invented, nothing dropped, no side taken on a point that was left open, and no finding described as worse or milder than it was settled to be. If it drifts, fix the document in place and keep its structure. If it is accurate, leave it alone.

Return the structured result with the path and whether you changed it.`
}

/** Quinn's last pass: the fix list is the deliverable, so the verifier signs it off, counts and all. */
export function checkFindingsPrompt(pr: PrContext): string {
  const { files, roundsDir } = pathsOf(pr)
  const since = sinceOf(pr)
  const previous = since === null ? '' : `\n- The \`## Previous findings\` table has one row per finding in ${files.previousFindings}, in the state you ruled, and a \`fixed\` row cites a line the delta changes.`
  return `You are Quinn. Nova has written ${files.findings} for the review of ${pr.label}. Sign it off.

Read every file under ${roundsDir}/ and then ${files.findings}${pr.packet === undefined || pr.packet === null ? `, with ${files.patch} and ${files.changed}` : ' (one `read_files` call; the index of the change is in the packet above, and the hunks of the files the entries cite come from one `read_diff` call)'}. Check that:

- Every entry cites a path the diff actually changes.
- Every severity is where it finally landed after your rulings, not where it started.
- Nothing you rejected or folded into another id survived.
- Nothing the seats settled is missing.
- No two entries describe one fix.
- The severity sections run critical, high, medium, low, info, the totals line counts exactly the entries under them, and every entry opens with its \`**What this means:**\` line; add the line where Nova left it out.${previous}

Fix the file in place where it drifts; keep its structure. Leave it alone if it is right.

Return the structured result with the path, whether you changed it, and \`counts\`: the findings in the file as it now stands, by severity. The counts are what the verdict is computed from, so count what is in the file, not what you remember.`
}

/** The per-seat round files, in the order a transcript should read. */
export function roundFilesInOrder(rounds: number, roundsDir: string = ROUNDS_DIR): string[] {
  const order: Reviewer[] = [...SEATS, 'quinn']
  const files: string[] = []
  for (let round = 1; round <= rounds; round += 1) {
    for (const who of order) files.push(roundFile(round, who, roundsDir))
  }
  return files
}

/** Models return what they like; the verdict must not depend on that. */
export function normalizeCounts(input: unknown): Counts {
  const raw = (input ?? {}) as Partial<Record<Severity, unknown>>
  const counts = { ...EMPTY_COUNTS }
  for (const severity of SEVERITIES) {
    const value = Number(raw[severity])
    counts[severity] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  return counts
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'review'
  )
}
