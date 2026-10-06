// Rules that earned their place in the implementor's own instruction files, each pinned by the
// sentence that carries it. A rewrite that drops the sentence reads as a harmless tidy-up; the
// skill-rules test makes it a failure with the reason attached. Rewording is fine: update the
// phrase and keep the reason. The skill test uses the same list the other way round: none of
// these sentences may appear in the Claude Code skill, which only launches the agent.

/** The implementor's procedure: eve loads it with load_skill, and --local embeds it in every prompt. */
export const PROCEDURE = 'agent/skills/aspira-implementor/SKILL.md'
/** The implementor's system prompt (cloud differences). */
export const INSTRUCTIONS = 'agent/instructions.md'

/** One rule, the reason it exists and the sentence that carries it. */
export type PinnedRule = { reason: string; file: string; phrase: string }

/** Every pinned rule, with the agent file it lives in. */
export const PINNED_RULES: PinnedRule[] = [
  { reason: 'a red test proves the instrument only when it fails for the predicted reason, not an import error', file: PROCEDURE, phrase: 'they must fail for the reason the plan predicts' },
  { reason: 'green by suppression is not green', file: PROCEDURE, phrase: 'Never get to green by adding `eslint-disable`' },
  { reason: 'config edits hide failures from every later run', file: PROCEDURE, phrase: 'never edit linter or test config to make a failure go away' },
  { reason: 'a wrong planned test is a plan defect, not something to quietly fix', file: PROCEDURE, phrase: 'If a test in the plan is wrong, that is a blocker to report' },
  { reason: 'the human is not watching; blocking on confirmation stalls the whole build', file: PROCEDURE, phrase: 'Do not stop to ask for confirmation, approval of the plan or permission to continue' },
  { reason: 'assumptions are only safe when the human can see and overturn them', file: PROCEDURE, phrase: 'Report every assumption in the summary so the human can overturn it' },
  { reason: 'irreversible or high-risk choices are the one thing not to guess', file: PROCEDURE, phrase: 'destructive data migrations, deleting user data, auth/permission models, payments, security boundaries' },
  { reason: 'a stale plan rewrites files that moved; drift is a blocker, not something to re-plan around', file: PROCEDURE, phrase: "Compare the plan's `repoCommit`" },
  { reason: 'a build on the default branch mixes unreviewed work into it; the session must branch first', file: PROCEDURE, phrase: 'never on the default branch, and settle it before writing any file' },
  { reason: 'a rerun must continue on the existing feature branch, not fork a second one', file: PROCEDURE, phrase: 'switch to the dedicated branch if it already exists' },
  { reason: 'building on a branch for different work tangles two features in one history', file: PROCEDURE, phrase: 'Do not build on it or branch from it' },
  { reason: "other people's uncommitted work is never staged, stashed or reverted", file: PROCEDURE, phrase: 'Leave uncommitted changes that are not yours alone' },
  { reason: 'skimming the rules is how MUST rules get missed', file: PROCEDURE, phrase: 'Do not skim: use full reads, never `head`' },
  { reason: 'unlisted dependencies are an approved-technologies decision, not a build detail', file: PROCEDURE, phrase: 'A dependency the plan did not name is a blocker, not a judgment call' },
  { reason: 'a project instruction that contradicts a Notion rule is a human decision', file: PROCEDURE, phrase: 'If a project instruction conflicts with a Notion rule, stop and put the conflict to the human' },
  { reason: 'workers get the rules in their brief; N workers re-reading Notion is cost and drift', file: PROCEDURE, phrase: 'Workers do not re-fetch Notion' },
  { reason: 'hot files conflict even when the plan forgot them; two lanes on one barrel file is a broken build', file: PROCEDURE, phrase: '**Hot files** always conflict, even when the plan forgot to list them' },
  { reason: 'a worker sees none of the orchestrator context', file: PROCEDURE, phrase: 'Its brief must stand alone' },
  { reason: 'a worker that needs a file outside its scope stops; editing it races the other lanes', file: PROCEDURE, phrase: 'STOP and report it as a blocker. Do not edit it.' },
  { reason: 'worker reports are claims; the orchestrator checks the tree', file: PROCEDURE, phrase: 'Do not trust the reports' },
  { reason: 'a stray edit outside every write scope is never committed by accident', file: PROCEDURE, phrase: "every changed path must be in some lane's write scope" },
  { reason: 'silent workarounds are the failure mode the whole pipeline is built to prevent', file: PROCEDURE, phrase: 'Working around a blocker in silence is the failure mode' },
  { reason: 'a reviewed plan is a contract; changing it silently voids the review', file: PROCEDURE, phrase: 'Never re-plan silently' },
  { reason: 'a feature is done when its tests pass, not when its code compiles', file: PROCEDURE, phrase: 'A feature with a failing or missing test is not done' },
  { reason: 'review separation: green tests are not review', file: PROCEDURE, phrase: 'The builder does not approve its own code' },
  { reason: 'repeated mistakes become Slop Repo entries, not memory', file: PROCEDURE, phrase: 'add an entry to the AI Agent Slop Repo in Notion' },
  { reason: 'a dependency nobody listed is a store build or an approval nobody saw coming', file: PROCEDURE, phrase: 'Every dependency the build added is listed, with its native and approval flags' },
  { reason: 'notes written mid-build describe a tree that no longer exists; stale notes mislead the reviewer', file: PROCEDURE, phrase: 'rewritten from the code at HEAD or deleted' },
  { reason: 'a bug fixed and forgotten is fixed twice; the proposed Slop Repo entry is the record', file: PROCEDURE, phrase: 'The report cannot be done with the section empty or missing' },
  { reason: 'lane copies share the sandbox; a second checkout or publish corrupts the run', file: INSTRUCTIONS, phrase: 'Copies do not call `checkout-repo`, `load-knowledge` or `publish-branch`' },
  { reason: 'work that exists only in a dead sandbox was never done', file: INSTRUCTIONS, phrase: 'call `publish-branch` once, even for a partial or blocked build' },
  { reason: 'the cloud path has no driver; the tool schema is what stops a report without the three sections', file: INSTRUCTIONS, phrase: 'Call `record-verification` once' },
  { reason: 'the launcher owns the board moves around a cloud run; the agent must not make a third', file: INSTRUCTIONS, phrase: 'do not move the card yourself' },
]

/** The skill's own mechanics for the ticket flow, pinned the same way; these live in the skill, not the agent. */
export const PINNED_SKILL_RULES: PinnedRule[] = [
  { reason: 'the ticket is the argument; a path is the exception and must be asked for', file: 'skill/aspira-implementor/SKILL.md', phrase: 'A file path only works with `--no-ticket`' },
  { reason: 'the gate runs before any model call, so a wrong Status costs nothing', file: 'skill/aspira-implementor/SKILL.md', phrase: 'refused before any model call' },
  { reason: 'the skill owns exactly two moves; a session that moves cards on its own drifts from the board', file: 'skill/aspira-implementor/SKILL.md', phrase: 'Never move a card anywhere the stage does not list' },
  { reason: 'a human owns every Ready column (BOARD-004)', file: 'skill/aspira-implementor/SKILL.md', phrase: 'It never moves a card to a Ready column' },
  { reason: 'the implementor moves to In Review: Implementation only with the PR open and set (BOARD-005)', file: 'skill/aspira-implementor/SKILL.md', phrase: 'only when it opened the PR' },
  { reason: 'a local build pushes nothing, so the PR is the human\'s remaining step and the report must say so', file: 'skill/aspira-implementor/SKILL.md', phrase: 'opening the PR is the remaining step' },
  { reason: 'a push failure is reported with the local path and the move is still made', file: 'skill/aspira-implementor/SKILL.md', phrase: 'say so with the local path of the implementation report and still make the move' },
  { reason: 'the report starts with the ticket, the moves, the pages pushed and the working folder', file: 'skill/aspira-implementor/SKILL.md', phrase: 'Start the report with the ticket ID and title' },
]
