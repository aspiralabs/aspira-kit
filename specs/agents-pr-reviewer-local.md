# pr-reviewer: local mode

## Intent

Run the official pr-reviewer pipeline inside a Claude Code session, with every seat and the verifier on the session's model (Opus), and post the result to the GitHub PR. This is the same arrangement `aspira-spec-reviewer --local` already offers. Today pr-reviewer only runs as a separate eve process: six Opus seats plus Quinn on gpt-6-luna, billed through the Vercel AI Gateway. That run cost $12.57 on a large PR, and there is no skill to launch it from a session.

## Acceptance criteria

### Features

- [ ] F1: An `aspira-pr-reviewer` skill ships in `packages/agents/pr-reviewer/skill/aspira-pr-reviewer/` (`SKILL.md` plus `scripts/pr-reviewer.sh`). It has two modes. Default `start` launches the existing agent as a separate process, with `status` and `wait` the way the other skills work. `--local` runs the pipeline in the session.
- [ ] F2: `pr-reviewer.sh local <source> [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR] [--knowledge DIR] [--finish]` is a step driver that makes no model calls. `<source>` is a GitHub PR (URL or `owner/name#N`) or a local repository path plus branch, with base `main` by default. Each call either prints JSON naming the stage and its tasks, with each task's exact agent prompt written to a file and an output path, or, once every stage is done, writes the review and prints the result. The stages, prompts and output schemas are the ones `pr-debator` uses (opening and turn prompts per seat, `verifyPrompt`, `writeFindingsPrompt`, `writeReviewPrompt`, `checkFindingsPrompt`, the review check), read from `agent/lib/review.ts`. They are not copies.
- [ ] F3: Rounds follow `pr-debator`. Round 1 is six seats in parallel, then Quinn. Later rounds use the turn prompts. The run stops when all six seats and Quinn report `agreed`, or at the round cap (default `DEFAULT_MAX_ROUNDS`, at most `MAX_ROUNDS_LIMIT`). Then Nova writes findings and Dex writes the review, and Quinn and Nova check them. Counts come from Quinn's check, falling back to Nova's, and the verdict is `verdictFrom(counts)`. Each task output is validated against the stage's schema; an invalid output returns an `error` the session can resend once, and `--finish` exports what exists with the missing stages recorded.
- [ ] F4: The workspace paths that prompts reference (`/workspace/pr.patch`, `/workspace/changed_files.txt`, `/workspace/pr.md`, the round files, the findings and review files, and the repo tree) resolve to a local work directory. The repo tree is the checked-out source: a local checkout, or a shallow clone of the PR head for a GitHub PR, made with `gh` or `GITHUB_TOKEN`. The work directory is `<output>.local/` and is deleted after export, with every prompt and output kept in `trace/calls.json`.
- [ ] F5: Export matches the agent. A local repository gets `.pr-review/<branch>/`; a GitHub PR gets `reviews/<date>-<slug>/`. The same files are written: `review.md`, `findings.md`, `conversation.md`, `pr.md`, `pr.patch`, `changed_files.txt`. `cost.md` says the run happened in a Claude Code session and itemizes no cost.
- [ ] F6: For a GitHub PR, unless `--no-comment` is given, the review is posted or updated through `upsertReviewComment`, the same marker and body as `comment-on-pr`, using `GITHUB_TOKEN` or `gh auth token`. Without a token it reports `posted: false` with the reason. It never posts to any PR other than the one reviewed.
- [ ] F7: `SKILL.md` tells the session how to run each stage: launch every seat task of a round in one message as parallel subagents, each told to read its prompt file and write its JSON output. It says that `--local` is not independent of the session, and that every phase runs on the session's model.
- [ ] F8: The Notion engineering guidelines are mandatory in `--local`, exactly as the agent loads them. The rules come from load-knowledge's own configuration: the agent's `KNOWLEDGE_PAGE` and `KNOWLEDGE_REQUIRED`, read from the environment and then the agent's env files, never the token, and load-knowledge's `MAX_DEPTH` and `MAX_PAGES`.
  - The session builds the guidelines folder with the Notion MCP before the first review step. The folder is `<work>/knowledge/` (where `/workspace/knowledge` maps) or `--knowledge DIR`, in load-knowledge's shape:
    - `INDEX.md`, the root page;
    - one kebab-case file per page reached from the root;
    - `REQUIRED.md`, the required pages in full, each under `# <page title>` and separated by `---`, rule IDs kept.
  - If a page is truncated or cannot be fetched, the session stops and says so.
  - The driver refuses to start, with a clear error, exit 3 and a `stage: "knowledge"` plan listing the folder, root, required pages and limits, unless `INDEX.md` and `REQUIRED.md` exist, are not empty, and `REQUIRED.md` has a section for every required page. There is no flag to skip this.
  - The folder's path and its `REQUIRED.md` go into `PrContext` as `knowledgePath` and `knowledgeRequiredFile`, so every seat and Quinn prompt carries the agent's knowledge section with the local paths.
  - The folder's content is fingerprinted into the run state. A change mid-run, or a different `--knowledge`, is refused.
  - The export copies the folder to `trace/guidelines/` and records its path, fingerprint and files in `trace/calls.json`.
- [ ] F9: Single source of truth: the skill only calls the agent, and `--local` reuses the agent's own instruction files at runtime.
  - Every prompt file is assembled on each `local` call from the files on disk: `agent/subagents/<seat>/instructions.md` verbatim as the system prompt, and the `agent/lib/review.ts` prompt and schema. Changing those files changes the next prompt.
  - Each step names `agent/instructions.md` as `orchestrator`, and the export includes its current text. The session acts as the orchestrator by that file.
  - `SKILL.md` describes only the mechanics of running the steps and points to the agent's files as the authority. It restates none of the agent's rules.
  - The only text the driver adds to a prompt is how a session turn differs from an eve turn: real paths and the output file.

## Implementation and verification plan

- `scripts/local.ts` holds the state machine, kept pure where possible; `skill/.../scripts/pr-reviewer.sh` is modelled on `spec-reviewer.sh`.
- Unit tests:
  - stage sequencing: agreement stops the loop early, and the round cap is honoured;
  - prompts are byte-equal to `review.ts` for the mapped paths;
  - schema rejection;
  - `--finish` with missing stages;
  - export layout for both sources;
  - comment posting with a fake GitHub (reuse `github-comment.test.ts`'s fake);
  - refusal to continue when the source changes mid-run;
  - refusal without `REQUIRED.md` or `INDEX.md`, or without a configured required page;
  - knowledge section in the prompts, byte-equal to `review.ts` for the mapped paths;
  - refusal when the guidelines change mid-run;
  - guidelines in the export;
  - the knowledge plan comes from the agent's configuration;
  - a prompt file holds the current bytes of the seat's `instructions.md` and follows changes to it.
- `skill.test.ts` / `skill-rules.test.ts` cover the new skill, as for spec-reviewer. `skill-rules.test.ts` also asserts that `SKILL.md` restates none of `agent/instructions.md`'s rules and references that file.
- Run `pnpm --filter @aspiralabs/pr-reviewer test`, `typecheck` and `lint`.

## Out of scope

Changing seat prompts, lenses or the verdict rule; a cheaper model mix for the default mode; excluding paths from the diff.
