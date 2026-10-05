// Pure helpers for the pr-debator workflow. No eve imports, no side effects, so
// the seats, prompts, schemas, and the verdict can be tested without a runtime.

export const FILES = {
  meta: '/workspace/pr.md',
  patch: '/workspace/pr.patch',
  changed: '/workspace/changed_files.txt',
  conversation: '/workspace/conversation.md',
  findings: '/workspace/findings.md',
  review: '/workspace/review.md',
} as const

export const REPO_PATH = '/workspace/repo'
export const ROUNDS_DIR = '/workspace/review'

export const roundDir = (round: number) => `${ROUNDS_DIR}/round-${round}`
export const roundFile = (round: number, who: Reviewer) => `${roundDir(round)}/${who}.md`

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

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]
export type Counts = Record<Severity, number>

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
        'true only if every open finding — yours and everyone else’s — is accepted, withdrawn, or rejected, and you raised nothing new this turn.',
    },
    openPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Finding ids still disputed or unanswered, each with a one-line summary. Empty when agreed.',
    },
    note: { type: 'string', description: 'One sentence on where the review stands from your seat.' },
  },
  required: ['agreed', 'openPoints', 'note'],
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

export type TurnOutput = { agreed: boolean; openPoints: string[]; note: string }
export type VerifyOutput = TurnOutput & { rejected: string[]; duplicates: string[] }
export type DocOutput = { path: string; changed: boolean; note: string }
export type FindingsOutput = DocOutput & { counts: Counts }

export type PrContext = {
  /** Human label for the transcript header: `owner/name#123` or a local path with its base ref. */
  label: string
  /** Sandbox path of the checked-out tree, or null when only a patch was given. */
  repoPath: string | null
  /** Sandbox path of the engineering guidelines from load-knowledge, or null when not loaded. */
  knowledgePath?: string | null
  /** REQUIRED.md from load-knowledge: the pages every seat reads in full, first. */
  knowledgeRequiredFile?: string | null
}

const knowledgeSection = (pr: PrContext) =>
  pr.knowledgePath === undefined || pr.knowledgePath === null
    ? ''
    : `

${pr.knowledgeRequiredFile === undefined || pr.knowledgeRequiredFile === null ? '' : `Required reading is ${pr.knowledgeRequiredFile}: the pages every reviewer must ingest in full. Your first command is \`cat ${pr.knowledgeRequiredFile}\`. Read every line; never pipe a knowledge file through \`head\` or grep it for headings. A rule there that names a check is a step you run before writing a finding. `}The org's engineering guidelines are at ${pr.knowledgePath}, indexed in ${pr.knowledgePath}/INDEX.md. Read the pages that cover what this diff touches. A guideline is a rule, not a preference: a change that contradicts one is a finding at the severity the guideline implies, citing the file. Where the guidelines are silent, review on the merits as usual. Cite guideline files; do not quote them at length.`

const repoSection = (pr: PrContext) =>
  pr.repoPath === null
    ? `There is no checked-out tree for this review — you have the diff and nothing else. Review the patch alone. Do not guess at code you cannot see: if a finding depends on how something outside the diff behaves, say that the finding is conditional and on what.`
    : `The repository is checked out at ${pr.repoPath}. Read it. The diff shows what changed; the tree shows what it changed *into*, and a diff read without its surroundings produces confident nonsense. Search with \`rg\` or \`grep -rn\`, list with \`ls\`/\`find\`, open files with read_file. Do not modify the tree and do not run the project.`

const context = (pr: PrContext) => `What you are reviewing, in the sandbox:

- ${FILES.meta} — the pull request: title, description, base and head.
- ${FILES.patch} — the unified diff. This is the change. Everything you flag lives in here.
- ${FILES.changed} — the changed paths, one per line.

${repoSection(pr)}${knowledgeSection(pr)}`

const FINDING_RULES = `Finding rules, all seats:

- Review only what the diff changes. A finding about code the diff does not touch is out of scope and Quinn will reject it.
- Every finding cites a path from ${FILES.changed} and a line or line range, and quotes the evidence from the diff.
- Copy paths from ${FILES.changed} or ${FILES.patch}. Never assemble one from memory of how the project is probably laid out: \`components/ui/core/alert.tsx\` and \`components/ui/core/alert/alert.tsx\` are different files, and only one of them exists. If read_file says a path is not there, the path was wrong — find the real one with \`rg --files | rg <name>\` before you write anything about it.
- Severity is one of \`critical\`, \`high\`, \`medium\`, \`low\`, \`info\`. Confidence is a number from 0 to 1. Both are yours to defend.
- Prefer the exploitable, reachable, and concrete over the theoretical. Three real findings beat ten vague ones.
- Do not spend a finding on what typecheck, lint, or prettier already catches. Those gates run before you do.
- Nothing to say is a result. Write "None." and mean it.`

const sectionShape = (who: Seat, round: number) => `## Round ${round} — ${DISPLAY_NAME[who]} (${LENS[who]})

### Responses
One line per open finding from another seat that touches your lens, and one line per ruling Quinn made on *your* findings: \`[ID] accept\`, \`[ID] withdraw — reason\`, or \`[ID] dispute — evidence from the diff or the tree\`. Disputing Quinn is allowed when you have evidence; saying nothing is not. Skip this heading in round 1.

### Findings
Your new findings, each as:

\`#### [${PREFIX[who]}${round}.1] <severity> · <category> · <path>:<line-or-range> · confidence <0.0-1.0>\`

then three short blocks: what is wrong, the evidence quoted from the diff, and the fix. Write "None." if you have none.

### Position
One short paragraph: what you now believe must change in this PR, across every point that was ever raised in your lens.

### Status
\`agreed\` or \`open\`, followed by the ids still open. An accepted, withdrawn, or rejected finding is closed; do not list it.`

const protocol = (who: Seat, round: number) => `Protocol, every turn:

1. Read ${FILES.meta}, ${FILES.patch}, and ${FILES.changed} in full. Then read every file under ${ROUNDS_DIR}/ — every seat's rounds and every one of Quinn's verification files. Do not rely on memory; the files are the record. \`find ${ROUNDS_DIR} -type f | sort\` lists them.
2. Write ${roundFile(round, who)}. One file, yours alone, this round only. Never edit another seat's file and never edit your own earlier rounds. The shape:

${sectionShape(who, round)}

3. Return the structured result. \`agreed\` is true only when nothing in your lens is still open and you raised no new findings this turn.`

export function openingPrompt(who: Seat, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}, the ${LENS[who]} seat. This is round 1 of a review of ${pr.label}. Five other seats are reviewing the same diff in parallel through their own lenses, and Quinn verifies all of it after every round. You do not know which model any of them is. Do not defer to them.

${context(pr)}

${FINDING_RULES}

${protocol(who, 1)}`
}

export function turnPrompt(who: Seat, round: number, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}, the ${LENS[who]} seat, in round ${round} of the review of ${pr.label}. Every other seat has written since you last read the record, and Quinn has ruled on round ${round - 1}.

${context(pr)}

${FINDING_RULES}

${protocol(who, round)}`
}

export function verifyPrompt(round: number, pr: PrContext): string {
  return `You are Quinn, the verification seat for the review of ${pr.label}. You are independent of the six reviewers twice over: they hunt and you check, and you run on a different model family than any of them. You raise no findings of your own. Your job is to keep the list honest.

${context(pr)}

Read every file under ${ROUNDS_DIR}/ — all seats, all rounds including your own earlier rulings. For every finding that is still open, read the actual code at the path and lines it cites, cross-reference it against ${FILES.patch}, and rule on it.

Write ${roundFile(round, 'quinn')}:

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
- **A failed read is not evidence against a finding.** If read_file cannot open the path a finding cites, the citation may be wrong while the finding is right. Locate the real file first — \`rg --files | rg <name>\` — and rule on the code. Reject for a bad path only after you have looked and the code is not there under any name. Never spend two calls on a path that has already failed once.
- A seat may dispute your ruling with evidence. Read the dispute and rule again; change your mind when the evidence is better than yours, and say so. Do not hold a ruling out of consistency.

### Standing
The current list: every surviving finding id with its final severity, grouped by severity, highest first. Then one line per finding still contested and who is contesting it.

Return the structured result. \`agreed\` is true only when every finding has a settled ruling that no seat is still disputing.`
}

export function writeFindingsPrompt(pr: PrContext, agreed: boolean): string {
  const unresolved = agreed
    ? ''
    : `\n\nThe review hit its round cap without full agreement. End the file with \`## Unresolved\`: one entry per finding still contested, both positions stated plainly, and what a human has to decide. Do not pick a side and do not count these in \`counts\`.`
  return `You are Nova. The review of ${pr.label} is over. Write the fix list.

Read ${FILES.patch}, ${FILES.changed}, and every file under ${ROUNDS_DIR}/ in full, then write ${FILES.findings}: what this PR has to fix, settled, deduplicated, in severity order.

Shape:

\`# Findings: ${pr.label}\`, then exactly one totals line in this form: \`Totals: <n> critical · <n> high · <n> medium · <n> low · <n> info\`, then \`## Critical\` / \`## High\` / \`## Medium\` / \`## Low\` / \`## Info\` — skip a heading with nothing under it. Under each, one \`### [ID] <one-line title>\` per finding with: location as \`path:line\`, what is wrong, the evidence quoted from the diff, the fix, who raised it, and Quinn's ruling in a few words.

Rules:

- Only findings that survived verification. Nothing Quinn rejected, nothing Quinn folded into another id, nothing a seat withdrew.
- Keep the id and the severity as they finally stood, not as first written. Where Quinn adjusted severity, use the adjusted one.
- One entry per real problem. If two surviving ids describe one fix, Quinn missed a duplicate — merge them and say so in the entry.
- No praise, no summary of the debate, no hedging. This is a work list.
- Do not write a verdict line. The verdict is computed from your counts, not asserted.${unresolved}

Return the structured result with the path, \`changed: true\`, and \`counts\`: how many findings you actually wrote at each severity.`
}

export function writeReviewPrompt(pr: PrContext, agreed: boolean): string {
  const unresolved = agreed ? '' : ` Say plainly that the seats did not settle everything, and name what is still open in one line each.`
  return `You are Dex. The review of ${pr.label} is over. Write the summary the author reads first.

Read ${FILES.meta}, ${FILES.patch}, and every file under ${ROUNDS_DIR}/ in full, then write ${FILES.review}: plain English, for the person who opened this PR and will not read the transcript.

Sections:

- \`# Review: ${pr.label}\`
- \`## What this change does\` — two to four sentences, from the diff, not from the PR description.
- \`## Fix before merge\` — the critical and high findings, one bullet each, in the author's words: what breaks, where, and what to do. No ids in the sentence; put the id in brackets at the end.
- \`## Worth fixing\` — medium and low, same shape. One line saying "nothing" if there is nothing.
- \`## Checked and clean\` — what the seats looked at and found nothing wrong with, one line per lens. This is what makes the rest trustworthy.${unresolved}

No praise for the author, no praise for the seats, no filler, no hedging. If the change is good, say it in one sentence and move on.

Return the structured result with the path and \`changed: true\`.`
}

export function reviewDocPrompt(who: Reviewer, path: string, pr: PrContext): string {
  return `You are ${DISPLAY_NAME[who]}. ${path} has been written for the review of ${pr.label}.

Read every file under ${ROUNDS_DIR}/ and then ${path}. Check it against the record: nothing invented, nothing dropped, no side taken on a point that was left open, and no finding described as worse or milder than it was settled to be. If it drifts, fix the document in place and keep its structure. If it is accurate, leave it alone.

Return the structured result with the path and whether you changed it.`
}

/** Quinn's last pass: the fix list is the deliverable, so the verifier signs it off, counts and all. */
export function checkFindingsPrompt(pr: PrContext): string {
  return `You are Quinn. Nova has written ${FILES.findings} for the review of ${pr.label}. Sign it off.

Read ${FILES.patch}, ${FILES.changed}, every file under ${ROUNDS_DIR}/, and then ${FILES.findings}. Check that:

- Every entry cites a path the diff actually changes.
- Every severity is where it finally landed after your rulings, not where it started.
- Nothing you rejected or folded into another id survived.
- Nothing the seats settled is missing.
- No two entries describe one fix.

Fix the file in place where it drifts; keep its structure. Leave it alone if it is right.

Return the structured result with the path, whether you changed it, and \`counts\`: the findings in the file as it now stands, by severity. The counts are what the verdict is computed from, so count what is in the file, not what you remember.`
}

/** The per-seat round files, in the order a transcript should read. */
export function roundFilesInOrder(rounds: number): string[] {
  const order: Reviewer[] = [...SEATS, 'quinn']
  const files: string[] = []
  for (let round = 1; round <= rounds; round += 1) {
    for (const who of order) files.push(roundFile(round, who))
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
