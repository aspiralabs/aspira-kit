# pr-reviewer: local mode

## Intent

Run the official pr-reviewer pipeline inside a Claude Code session, with every seat and the verifier on the session's model (Opus), and post the result to the GitHub PR. This is the same arrangement `aspira-spec-reviewer --local` already offers. Today pr-reviewer only runs as a separate eve process: six Opus seats plus Quinn on gpt-6-luna, billed through the Vercel AI Gateway. That run cost $12.57 on a large PR, and there is no skill to launch it from a session.

## Acceptance criteria

### Features

- [ ] F1: An `aspira-pr-reviewer` skill ships in `packages/agents/pr-reviewer/skill/aspira-pr-reviewer/` (`SKILL.md` plus `scripts/pr-reviewer.sh`). It has two modes. Default `start` launches the existing agent as a separate process, with `status` and `wait` the way the other skills work. `--local` runs the pipeline in the session.
- [ ] F2: `pr-reviewer.sh local <source> [--max-rounds N] [--no-comment] [--finish]` is a step driver that makes no model calls. `<source>` is a GitHub PR (URL or `owner/name#N`) or a local repository path plus branch, with base `main` by default. Each call either prints JSON naming the stage and its tasks, with each task's exact agent prompt written to a file and an output path, or, once every stage is done, writes the review and prints the result. The stages, prompts and output schemas are the ones `pr-debator` uses (opening and turn prompts per seat, `verifyPrompt`, `writeFindingsPrompt`, `writeReviewPrompt`, `checkFindingsPrompt`, the review check), read from `agent/lib/review.ts`. They are not copies.
- [ ] F3: Rounds follow `pr-debator`. Round 1 is six seats in parallel, then Quinn. Later rounds use the turn prompts. The run stops when all six seats and Quinn report `agreed`, or at the round cap (default `DEFAULT_MAX_ROUNDS`, at most `MAX_ROUNDS_LIMIT`). Then Nova writes findings and Dex writes the review, and Quinn and Nova check them. Counts come from Quinn's check, falling back to Nova's, and the verdict is `verdictFrom(counts)`. Each task output is validated against the stage's schema; an invalid output returns an `error` the session can resend once, and `--finish` exports what exists with the missing stages recorded.
- [ ] F4: The workspace paths that prompts reference (`/workspace/pr.patch`, `/workspace/changed_files.txt`, `/workspace/pr.md`, the round files, the findings and review files, and the repo tree) resolve to a local work directory. The repo tree is the checked-out source: a local checkout, or a shallow clone of the PR head for a GitHub PR, made with `gh` or `GITHUB_TOKEN`. The work directory is `<output>.local/` and is deleted after export, with every prompt and output kept in `trace/calls.json`.
- [ ] F5: Export matches the agent. A local repository gets `.pr-review/<branch>/`; a GitHub PR gets `reviews/<date>-<slug>/`. The same files are written: `review.md`, `findings.md`, `conversation.md`, `pr.md`, `pr.patch`, `changed_files.txt`. `cost.md` says the run happened in a Claude Code session and itemizes no cost.
- [ ] F6: For a GitHub PR, unless `--no-comment` is given, the review is posted or updated through `upsertReviewComment`, the same marker and body as `comment-on-pr`, using `GITHUB_TOKEN` or `gh auth token`. Without a token it reports `posted: false` with the reason. It never posts to any PR other than the one reviewed.
- [ ] F7: `SKILL.md` tells the session how to run each stage: launch every seat task of a round in one message as parallel subagents, each told to read its prompt file and write its JSON output. It says that `--local` is not independent of the session, and that every phase runs on the session's model.

## Implementation and verification plan

- `scripts/local.ts` holds the state machine, kept pure where possible; `skill/.../scripts/pr-reviewer.sh` is modelled on `spec-reviewer.sh`.
- Unit tests:
  - stage sequencing: agreement stops the loop early, and the round cap is honoured;
  - prompts are byte-equal to `review.ts` for the mapped paths;
  - schema rejection;
  - `--finish` with missing stages;
  - export layout for both sources;
  - comment posting with a fake GitHub (reuse `github-comment.test.ts`'s fake);
  - refusal to continue when the source changes mid-run.
- `skill.test.ts` / `skill-rules.test.ts` cover the new skill, as for spec-reviewer.
- Run `pnpm --filter @aspiralabs/pr-reviewer test`, `typecheck` and `lint`.

## Out of scope

Changing seat prompts, lenses or the verdict rule; a cheaper model mix for the default mode; excluding paths from the diff.
