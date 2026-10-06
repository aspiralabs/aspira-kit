# pr-reviewer: less resent context, a stopping rule, a re-review mode and a budget

## Intent

The one cloud review of nomnomzz PR #2 (2026-10-05) cost $12.57: 328 model calls, 18 million input tokens, 16 million of them cache reads. Prompt caching already worked; the cost was volume. Six Opus seats made 40 to 56 calls each, mostly reading files one at a time across four rounds, and every call resent the whole conversation. Seats hold `agreed: false` until fixes land, so every review runs to the round cap. Each re-review after a fix round was a full review and surfaced a new layer of lows. Four changes: give the seats the material up front, batch what they still read, stop when the verdict is settled, and re-review only the delta. Plus a budget that stops a run at a dollar amount, and an estimate before any cloud run starts.

## Acceptance criteria

### Features

- [ ] F1: **The shared packet is an index, not the diff.** Before round one, `load-pr` builds one packet that is the identical cached prefix for every seat: the PR description; `REQUIRED.md`; and a changed-file index with one line per file: path, additions and deletions, an area tag derived from the path (api, db-migration, web-ui, mobile, lib, test, e2e, docs, config, infra), and the symbols the hunks touch (function, class, export and route names read from the hunk headers and added or removed declaration lines). No diff hunks and no file bodies are in the packet. On a PR of any size the packet stays small; on nomnomzz PR #3 (68 files, 12,448 changed lines) it must be under 15,000 tokens. Each seat then chooses the files its lens needs and fetches their hunks with one `read_diff(paths)` call and surrounding code with one `read_files(paths)` call; those contents live only in that seat's own context. The seat instructions say: pick from the index by your lens, fetch once in a batch, and do not fetch what you will not review. Quinn fetches only the files that findings cite.
- [ ] F2: **Reads are batched.** The seats and Quinn get one `read_files(paths: string[])` tool that returns many files in one call (each truncated the same way as the packet, with a pointer), and a `search(pattern, globs?)` tool that returns matches with two lines of context. The single-file `read_file` stays for one-offs. The seat instructions ask for one batched read of every file a seat wants before it writes, not a read per file. Each seat is capped at a configurable number of tool calls per round (`MAX_SEAT_CALLS`, default 8); at the cap the seat must write with what it has and list what it did not read.
- [ ] F3: **The review stops when the verdict is settled.** A seat marks `agreed: true` once every finding it raised has a verdict from Quinn (confirmed or rejected), not once the author has fixed it. Round two runs only when a seat disputes a Quinn verdict or raises a new finding in round one; a round with no dispute and no new finding ends the review. The round cap stays as a ceiling. The verdict comes from the counts as today.
- [ ] F4: **Re-review mode checks the delta.** `pr-reviewer <source> --since <previous review dir>` (and the agent's `review-again` entry) reads the previous `findings.md`, the previous head SHA recorded in it, and the diff from that SHA to the new head. The seats do two things only: for each previous finding, state whether the new diff fixes it, with the evidence line, or leaves it open; and raise new findings only on the delta. Unchanged code is out of scope and a finding on it is rejected by Quinn as before. The output is a `findings.md` with a **Previous findings** table (fixed, still open, withdrawn) and a **New findings** section, the same severity order, and `review.md` and the PR comment say it was a re-review of `<previous SHA>..<new SHA>`.
- [ ] F5: **Every review records what it reviewed.** `review.md`, `findings.md` and the PR comment carry the base SHA and head SHA the verdict applies to. A push after the review is visibly unreviewed. (This is item 2 of `IMPROVEMENTS.md`.)
- [ ] F6: **A budget stops the run, and an estimate precedes it.** `--max-cost <USD>` (default from `MAX_COST_USD`, unset means no cap) stops the run after the call that crosses it, exports what exists as incomplete with the spend, and says so in the report. Before a default (separate process) run starts, the skill prints an estimate: the diff size in changed lines, the seats and round cap, and a dollar range computed from the per-round averages recorded in this package's previous `cost.md` files (or the NOM-4 numbers as the seed), with one line saying `--local` costs session usage instead. The estimate is printed, not confirmed; `--yes` suppresses it for unattended runs.
- [ ] F7: **The cost file stays, with the new fields.** `cost.md` keeps its per-agent table and adds: calls per seat per round, the packet size in tokens, the cache-read share, and the budget if one was set.

### Tests

- [ ] unit: the packet builder on a fixture PR: every changed file present, the large-file rule applied, one packet object shared by all seat prompts (same string identity), `REQUIRED.md` included.
- [ ] unit: `read_files` returns each file or a truncation pointer; the per-round call cap forces a write with the unread list.
- [ ] unit: agreement logic: a seat with all findings ruled on is `agreed` even with none fixed; a round with no dispute and no new finding ends the review; a dispute runs one more round.
- [ ] unit: re-review on a fixture: a previous finding whose line is changed in the delta is reported with its new state and evidence; a finding on unchanged code is rejected; new findings only inside the delta; the SHAs render in all three outputs.
- [ ] unit: the budget stops after the crossing call and exports as incomplete; the estimate renders from a fixture of previous `cost.md` files.
- [ ] integration: `pr-reviewer --local` on the fixture repository from `local.test.ts`: round one with no dispute ends the review in one round; total model calls in `trace/calls.json` are at most `seats + 1 + 4` (seats, Quinn, the two writers and two checkers).
- [ ] benchmark: rerun on nomnomzz PR #2 at the commit the $12.57 review used, in default mode, and record calls, input tokens, cache-read share and cost beside the original in `specs/agents-pr-reviewer-context.benchmark.md`. The target is under 100 calls and under a third of the cost with the same critical and high findings.

## Implementation and verification plan

- F1 and F2 in `load-pr` and the seat tools (`packages/agents/pr-reviewer/agent/tools/`), then the seat instructions (`agent/subagents/*/instructions.md`) in one sentence each.
- F3 in `pr-debator` and the `local` driver's round logic, one shared predicate.
- F4 as a mode of `load-pr` (previous findings and SHA in the context) plus a prompt variant for the seats and Quinn; the renderer gains the two sections.
- F5 and F7 in the renderers; F6 in the launcher (`pr-reviewer.sh`) and the runner's usage ledger.
- Run the package's `test`, `typecheck` and `lint`; then the benchmark.

## Out of scope

Changing the seat line-up, the models, or the severity rules. Automatic fixing.
