# packages/agents: pr-review-agent

Status: drafted 2026-09-22 by the agent, awaiting review. Supersedes the scaffold that shipped with `packages/agents/`.

## Intent

Give `pr-review-agent` (`@aspiralabs/pr-review-agent`) behaviour: take a pull request, a branch, or a diff, put six specialist reviewers on it, and loop them until they agree on one fix list. Output is markdown — a fix list and a plain-English summary — written next to the repo and printed back in the reply.

The reviewer roles are ported from [nitpick](https://github.com/ilterkavlak/nitpick): security, performance, architecture, testing, and DX, plus a sixth seat for the design system, and nitpick's independent verification agent. What is *not* ported is nitpick's shape — no Upstash boxes, no interactive triage, no GitHub review posting. The loop is `spec-review-agent`'s: reviewers write into a shared record, respond to each other, and the workflow stops when every seat says the list is settled.

Why both: nitpick's parallel reviewers each produce a pile of findings that nobody reconciles, so a verifier has to clean up after them. A debate reconciles as it goes — a finding that another seat can refute dies in round two instead of reaching the author. The verifier stays because the debate alone does not check anything against the code: six seats can agree on a finding none of them opened the file for, and six seats from one model family can agree because they are one model family. Quinn is on another, and is the cheapest seat in the package — the work is mechanical, and it makes the most calls.

## Shape

One package, one root agent, seven subagents, three tools. Same layout rules as `spec-review-agent` (`packages/agents/README.md`).

```
packages/agents/pr-review-agent/agent/
├── agent.ts                      root orchestrator; tool: false
├── instructions.md               how to take a PR in and hand the markdown back
├── hooks/usage.ts                per-call token and cost ledger
├── tools/
│   ├── load-pr.ts                defineTool: repo + patch + changed files into the sandbox
│   ├── pr-debator.ts             defineWorkflowTool: the review loop
│   └── export-review.ts          defineTool: copy the markdown to the host, write cost.md
├── lib/
│   ├── review.ts                 pure: seats, prompts, schemas, verdict
│   ├── pr.ts                     pure: source parsing, git commands, patch stats
│   ├── usage.ts                  pure cost aggregation
│   └── usage-hook.ts             the hook mounted on every agent
└── subagents/
    ├── ava/    security        ├── reba/   testing
    ├── cole/   performance     ├── dex/    developer experience
    ├── nova/   architecture    ├── iris/   design system
    └── quinn/  verification (OpenAI)
```

### The seats

Six reviewers, one lens each, all on `anthropic/claude-opus-5.5`. The focus lists come from nitpick's `ROLE_PROMPTS`; the voice and the argument rules come from `subagents/darren/instructions.md`.

| Seat | Lens | Ported from |
| --- | --- | --- |
| Ava | injection, authz, secrets, crypto, deserialization, trust boundaries, TOCTOU | nitpick `security`, plus `personas/security.md` |
| Cole | complexity regressions, N+1, allocations, sync I/O in async paths, unbounded results, hot-path renders | nitpick `performance` |
| Nova | coupling, domain boundaries, error handling, API compatibility, dependency direction, god objects | nitpick `architecture` |
| Reba | missing coverage, edge cases, flaky patterns, integration gaps, error paths, assertion specificity | nitpick `testing` |
| Dex | naming, readability, misleading comments, inconsistent patterns, public API docs, setup friction | nitpick `dx` |
| Iris | `@aspiralabs/ui` components and variants, semantic tokens, `constraints.md` judgment calls | `personas/ui-review.md`, no nitpick equivalent |

Quinn is the seventh seat: `openai/gpt-6-luna`, nitpick's verification agent. Quinn raises no findings. Every round, Quinn reads the diff and the other seats' findings and marks each one `confirmed`, `adjusted` (severity or confidence moved, with the reason), `rejected` (false positive, or it references code the diff does not change), or `duplicate` (same root cause, same fix, as another id — Quinn names the id that survives). Quinn's rules are nitpick's, including "when in doubt between confirming and rejecting, lean towards confirming".

`tool: false` on all seven: only the workflow calls them, via `ctx.agent()`. All seven share the root's sandbox.

### Findings

Every finding carries nitpick's fields, written as markdown, not JSON:

`[AVA1.2] high · injection · path/to/file.ts:40-48 · confidence 0.8` followed by what is wrong, the evidence quoted from the diff, and the fix.

Severity is `critical | high | medium | low | info`, confidence is `0.0`–`1.0`, ids are `<SEAT><round>.<n>`. A finding without a file and line from the changed set is not a finding; a seat that writes one has its own round rejected by Quinn. The one exception is a `spec` finding about something the spec asks for that the diff never touches: it cites the spec section instead, and Quinn holds it to the same evidence bar (below).

## The loop

Input: `load-pr` takes `{ source?, branch?, base?, patch?, spec? }` — a GitHub PR reference, or a local repo path with the branch to review and the base to compare it against, or a pasted unified diff, plus an optional path to the spec the change was built from — and `pr-debator` takes the `{ label, repoPath }` it returns, plus `maxRounds`. Default `maxRounds` is 4, bounds 1..10. Six seats plus Quinn is seven model calls a round; the cap is lower than `spec-debator`'s for that reason.

1. **Load.** `load-pr` puts the tree at `/workspace/repo`, the unified diff at `/workspace/pr.patch`, the changed paths at `/workspace/changed_files.txt`, and the PR metadata at `/workspace/pr.md` — nitpick's file layout, which its prompts already assume. When a spec was given it is copied to `/workspace/spec.md` as well (see [Reviewing against a spec](#reviewing-against-a-spec)).
2. **Round 1.** All six seats run in parallel. Each reads `pr.md`, `pr.patch`, `changed_files.txt`, `spec.md` when present, and the repo, then writes `/workspace/review/round-1/<seat>.md`. Parallel seats cannot share one transcript file without clobbering it, so the record is one file per seat per round and every seat reads all of them.
3. **Verify.** Quinn runs after the seats, reads the whole round, and writes `/workspace/review/round-N/quinn.md`: one line per finding id with a status and a note.
4. **Round N.** Each seat reads every earlier round, responds to the findings aimed at it and to Quinn's rulings (`accept`, `withdraw`, or `dispute` with evidence), raises anything new, and restates its position. Then Quinn verifies again.
5. **Stop** when all six seats and Quinn return `agreed: true` in the same round, or at `maxRounds`. A seat may not declare agreement in a turn where it raised a new finding.
6. **Write.** Nova writes `/workspace/findings.md` (the settled fix list, ordered by severity) and Dex writes `/workspace/review.md` (plain English, for the person who opened the PR), in parallel. Then Quinn checks `findings.md` against the transcript and the diff, and Nova checks `review.md`, in parallel — each fixes drift in place or leaves it alone.
7. **Verdict.** Both the writer and the verifier return counts by severity for the fix list; Quinn's win, because Quinn read the file last. The workflow, not a model, computes `block` (any critical or high), `comment` (any medium or low), or `approve` (nothing but info) from them, and returns `{ verdict, counts, findings, agreed, rounds, openPoints, files }`. Counts are sanitised first: a missing, negative, or non-numeric count reads as zero, so a malformed answer cannot become an `approve`.

Hitting the cap is a failure of the review, not a result: both documents are still written, `findings.md` gets an `## Unresolved` section with both positions, and the tool reports `agreed: false`.

## Input sources

- **GitHub PR** — `https://github.com/owner/name/pull/123` or `owner/name#123`. Base and head sha, title, and body come from the GitHub API on the host (`GITHUB_TOKEN` when set, for private repos and rate limits). The clone happens in the sandbox with `--filter=blob:none`, then `git fetch origin pull/<n>/head` and a three-dot diff from the merge base.
- **Local repo** — three parts: the repo path as `source`, the `branch` to review, and the `base` to compare it against (default `main`, then `master`, then their `origin/` equivalents). The diff is `base...branch`: computed on the host from the merge base of the two, so commits that landed on main after the branch started are not in it.

  How the branch is read depends on whether it is checked out, because only the checked-out branch has a working tree:

  - **The checked-out branch** (or no `branch` given) is reviewed as it stands, uncommitted edits included. A plain working-tree diff omits files that were never `git add`ed — the newest code on the branch, and the most worth reviewing — so the diff is taken `--cached` against a scratch `GIT_INDEX_FILE` seeded from HEAD and staged with `git add -A`. The person's own index is never touched. The tree shipped to the sandbox is the working tree (tracked plus untracked-not-ignored). Untracked files that have nothing to do with the branch are reviewed too; that is what "as it stands" means.
  - **Any other branch** is committed history only: `git diff <merge-base> <branch>` out of the object database, and `git archive` of the branch's own tree. Nothing from the working tree, which belongs to a different branch.

  Either way the tree lands at `/workspace/repo`.
- **Pasted diff** — a unified diff with no repo. The seats review the patch alone; findings still need file and line.

On Vercel only the GitHub form works. Local paths are a laptop feature, same as `spec-review-agent`.

## Reviewing against a spec

Most of what this agent reviews was written by an agent from a spec, and none of the six lenses asks whether the change does what the spec says. Clean, well-tested, wrong code passes all six. An optional spec closes that gap.

**Input.** The prompt names it: "the spec is /abs/path/specs/foo.md". The orchestrator passes it to `load-pr` as `spec`, an absolute path on the host or a path inside the repo, and `load-pr` copies it to `/workspace/spec.md` next to `pr.md`. If the path does not exist, `load-pr` fails and the review stops, the same as a missing branch; a review that silently ran without the spec it was asked to use is worse than none. No spec given, no `spec.md`, and nothing else changes.

**Who reads it.** Every seat, every round. The sandbox is shared, so one copy is visible to all seven. Each seat's prompt says: if `/workspace/spec.md` exists, read it before the diff, and treat what it requires as part of your lens. Ava reads the security requirements it states, Reba reads the behaviours it says must be tested, Iris reads which components it names, and so on. There is no dedicated conformance seat: any seat may raise a spec finding under its own lens, and Quinn deduplicates the overlap as it does for everything else. The trade is a noisier round 1 against a smaller chance of a mismatch falling between seats; the loop already exists to absorb the noise.

**What a spec finding is.** Category `spec`, alongside nitpick's existing categories, in three shapes:

- the spec says A and the code does B — cites the file and line, and quotes the spec;
- the spec asks for C and nothing in the diff does it — cites the spec section, since there is no line to point at;
- the code does D and the spec never asked for it — cites the file and line. Scope creep is a finding, not a bonus.

Severity follows consequence, not category: a missing requirement that users would hit is `high`, an unrequested log line is `info`. A spec finding feeds the verdict like any other, so a feature that does not do what the spec says can `block`.

**What Quinn does with it.** Quinn reads `spec.md` too and verifies a spec finding by reading the section it cites and the code it names. Nitpick's rule still holds: a finding that references code the diff does not change is rejected, except the second shape above, which by definition references nothing in the diff and is instead checked against the spec text. A seat quoting a requirement the spec does not contain has its finding rejected, same as quoting code that is not there.

**The spec is evidence, not law.** A spec can be wrong, and the code may be right to depart from it. A seat that thinks so says so as a `dispute` with the reason, and the finding goes into `findings.md` either way, marked as the seat's position, so the person reading the review knows the spec and the code disagree and decides which one moves. What the agent never does is edit the spec; `spec-review-agent` exists for that.

## Output

`export-review` copies the markdown out of the disposable sandbox to the host. For a local review that is **inside the reviewed repo**: `<git root>/.pr-review/<branch>/`, one directory per branch, overwritten by the next review of that branch. The git root, not the path that was handed in, so a review of `packages/ui` lands in the repo's `.pr-review`, not in `packages/ui/.pr-review`.

`export-review` also appends `.pr-review/` to that repo's `.gitignore`, once, before writing anything. It is written first for a reason: the review output sits in the working tree, and a live review reads the working tree, so without the rule the next review of that branch would find the last one in its own diff. With it, both the diff and the tree shipped to the sandbox skip it, because `git add -A` and `git ls-files --exclude-standard` both honour `.gitignore`. The rule is added only when nothing there already covers it, existing content is never rewritten, and a repo that cannot be written to is reported rather than thrown — a finished review is not worth failing over a `.gitignore`.

The one cost of writing to `.gitignore` rather than `.git/info/exclude`: the two-line addition is itself an uncommitted change, so it appears in the next live review of that branch until it is committed. The trade is that teammates get the rule too.

A GitHub PR or a pasted diff has no checkout on this machine to write into, so those go to `reviews/<date>-<slug>/` in the package. `outputDir` overrides the location and skips the `.gitignore` line.

| File | What it is |
| --- | --- |
| `findings.md` | the settled fix list: verdict, counts, then one section per finding with severity, location, evidence, fix, who raised it, and Quinn's ruling |
| `review.md` | the plain-English summary for the PR author: what the change does, which spec it was checked against or that none was given, what must be fixed before merge, what is optional, what was checked and found clean |
| `conversation.md` | the full transcript, rounds concatenated in order |
| `pr.patch`, `changed_files.txt` | what was actually reviewed |
| `spec.md` | the spec it was reviewed against, verbatim; absent when none was given |
| `cost.md`, `usage.jsonl` | tokens and Gateway-reported USD per agent |

The root agent's reply is: verdict and counts on one line, cost on one line, the exported paths, then `review.md` verbatim, then an offer to print `findings.md`. `export-review` hands both documents back in its result so the root never has to read a host path it cannot see.

## Cost accounting

Copied from `spec-review-agent`: a `step.completed` hook on every agent appends one JSON line per model call to `/workspace/usage.jsonl` through a shell append, and `export-review` aggregates it into `cost.md`. `lib/usage.ts` and `lib/usage-hook.ts` are duplicated from the sibling package rather than shared, which `packages/agents/README.md` says not to do. Consolidating them into `@aspiralabs/config/agent/usage` changes a published package's public API and is a separate change; it is recorded here as debt, not done here.

## Out of scope

- Posting findings to GitHub as review comments, and interactive triage. nitpick does both; this reports and stops.
- Deterministic scanners (linters, secret scanning, dependency audits). `pnpm check` already runs in the repos this reviews; a seat that spends a finding on what the linter catches is wasting a round.
- Applying fixes. The seats read; they never write to the repo.
- Publishing, the `kit` CLI, deployment, channels beyond the default eve one.
- Evals with real models.

## Acceptance

- `pnpm --filter @aspiralabs/pr-review-agent typecheck` and `lint` pass; `pnpm check` at the root still passes.
- `eve info` discovers agent `pr-review-agent` with tools `load-pr`, `pr-debator`, `export-review`; seven subagents, all hidden; a `usage` hook on all eight.
- `load-pr` against a public GitHub PR and against a local branch both produce `/workspace/pr.patch` and a `changed_files.txt` whose paths match `git diff --name-only`.
- A local review of a branch that is *not* checked out contains that branch's commits and nothing else: no commits that landed on the base afterwards, and nothing from the working tree of the branch that is checked out.
- A local review of the checked-out branch includes its uncommitted edits and its never-added files, and leaves the person's git index exactly as it was.
- A review of a small real PR produces the export directory with all six files; every finding in `findings.md` cites a path present in `changed_files.txt` and carries a Quinn ruling.
- A local review writes to `<git root>/.pr-review/<branch>/` and leaves `.pr-review/` in that repo's `.gitignore`. Running it twice on the same branch does not add the rule twice, and the second run's diff does not contain the first run's output.
- Seats that disagree in round 1 converge or the run reports `agreed: false` at the cap with both positions recorded. Neither outcome loses the documents.
- The verdict is computed from counts, not asserted by a model: a run whose highest confirmed severity is `medium` returns `comment`.
- A review given a spec path copies it to `/workspace/spec.md`, exports it as `spec.md`, and names it in `review.md`. A review given a spec path that does not exist fails at `load-pr` and writes nothing.
- A review given a spec that asks for something the diff does not do produces a `spec` finding that cites the spec section, survives Quinn, and counts toward the verdict. A review given no spec produces no `spec` findings.

## Blast radius

Package-local. No published package changes, no changeset (`@aspiralabs/pr-review-agent` is already in the changeset `ignore` list). `@vercel/connect` is added as a dependency, matching `spec-review-agent`, because the tools open a sandbox. Needs Node 24, an AI Gateway credential, and — for private repos and for API rate limits — `GITHUB_TOKEN` in the environment.
