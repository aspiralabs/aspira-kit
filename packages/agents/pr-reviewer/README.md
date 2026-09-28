# @aspiralabs/pr-reviewer

Six specialist reviewers argue about your pull request until they agree on one fix list, with an independent verifier throwing out the ones that do not survive contact with the code. Built on [eve](https://vercel.com/eve).

Spec: `specs/agents-pr-reviewer.md`. The reviewer roles are ported from [nitpick](https://github.com/ilterkavlak/nitpick); the loop derives from the former spec debate implementation.

## The seats

| Seat | Lens | Model |
| --- | --- | --- |
| Ava | security: injection, authz, secrets, crypto, trust boundaries, TOCTOU | Claude Opus 5.5 |
| Cole | performance: complexity, N+1, allocations, sync I/O, unbounded results, hot paths | Claude Opus 5.5 |
| Nova | architecture: coupling, boundaries, error handling, API compatibility, dependency direction | Claude Opus 5.5 |
| Reba | testing: missing coverage, edge cases, flaky patterns, error paths, weak assertions | Claude Opus 5.5 |
| Dex | developer experience: naming, readability, misleading comments, undocumented APIs | Claude Opus 5.5 |
| Iris | design system: `@aspiralabs/ui`, tokens, variants, the constraints a linter cannot see | Claude Opus 5.5 |
| Quinn | verification: confirms, adjusts, rejects, and deduplicates every finding | OpenAI gpt-6-luna |

Quinn is independent twice over: it raises nothing, so it has no finding of its own to defend, and it runs on a different model family, so it is not agreeing with six Claude seats by construction. It is also the cheapest seat on purpose — checking a finding against the file it names is mechanical work, and Quinn makes more calls than anyone. On `gpt-6-astra` it was a third of the bill; `gpt-6-luna` is ~100x cheaper per token. `openai/gpt-6-sol` sits in between if the rulings ever start reading like rubber stamps.

## The loop

1. `load-pr` puts the tree at `/workspace/repo`, the diff at `/workspace/pr.patch`, the changed paths at `/workspace/changed_files.txt`, and the PR at `/workspace/pr.md`.
2. All six seats review in parallel, each writing its own file for the round. Then Quinn rules on every finding.
3. Next round: each seat reads everyone else's file and Quinn's rulings, and accepts, withdraws, or disputes with evidence.
4. Stop when all seven agree, or at the round cap (default 4, max 10).
5. Nova writes `findings.md`, Dex writes `review.md`, then Quinn signs off the fix list and Nova checks the summary.
6. The verdict — `block`, `comment`, `approve` — is computed from the counts. No model declares your PR fine.

Seven model calls a round, all but one on Opus. A four-round review is around thirty calls; `cost.md` tells you what it actually was.

## Run

Needs Node 24 and a Vercel AI Gateway key in `.env.local` (copy `.env.example`). `GITHUB_TOKEN` in the environment for private repos and for API rate limits.

```bash
KIT=/path/to/ASPIRA_KIT/packages/agents/pr-reviewer

pnpm -C $KIT dev                    # TUI
pnpm -C $KIT exec eve invoke "Review https://github.com/owner/name/pull/123"
pnpm -C $KIT exec eve invoke "Review the branch feat/checkout in $PWD against main, cap it at 2 rounds"
pnpm -C $KIT exec eve info          # what eve discovered
```

Three ways in:

- **A GitHub PR** — a URL or `owner/name#123`. The PR already says what it is against; it is cloned and diffed inside the sandbox.
- **A local repo** — the repo path, the branch to review, and the base to compare it against (default `main`). The diff is `main...branch`, taken from the merge base, so commits that landed on main after your branch started are not in it.
- **A pasted diff** — no repo. The seats review the patch alone and are told they cannot see the surrounding code.

For a local repo, whether the branch is checked out changes what you get:

| | Diff | Tree the seats read |
| --- | --- | --- |
| The checked-out branch (or no branch named) | `main...branch` **plus your working tree** — uncommitted edits and files you never `git add`ed | your working tree |
| Any other branch | `main...branch`, committed history only | that branch's own tree |

Reviewing the checked-out branch uses a scratch git index to pick up the never-added files, so your own index is never touched. It also means untracked files that have nothing to do with the branch get reviewed — that is what reviewing your working tree means.

Relative paths in your prompt resolve against the package directory, not your shell's. Pass absolute paths.

## Output

Markdown, written **into the repo you reviewed**, at `.pr-review/<branch>/` — one directory per branch, replaced by the next review of that branch. It goes to the git root, so reviewing `packages/ui` writes to the repo's `.pr-review`, not to `packages/ui/.pr-review`.

`.pr-review/` is added to that repo's `.gitignore` on the first review, so git never sees the output — and neither does the next review, which would otherwise find the last one sitting in its own diff. The rule is added once; nothing already in the file is touched. The one wart: that two-line `.gitignore` change is itself uncommitted, so it shows up in the next review of the branch until you commit it. (`.git/info/exclude` would avoid that and keep the rule off your teammates' machines — a one-line change in `export-review.ts` if you prefer it.)

A GitHub PR or a pasted diff has no local checkout to write into, so it goes to `reviews/<date>-<slug>/` in this package instead. `outputDir` overrides both and skips the `.gitignore` line.

| File | What it is |
| --- | --- |
| `review.md` | the summary for the PR author: what the change does, what must be fixed, what is optional, what was checked and found clean |
| `findings.md` | the fix list: verdict counts, then every surviving finding with severity, location, evidence, fix, who raised it, and Quinn's ruling |
| `conversation.md` | the full transcript, every seat, every round |
| `pr.md`, `pr.patch`, `changed_files.txt` | what was actually reviewed |
| `cost.md`, `usage.jsonl` | tokens and Gateway-reported USD per agent |

The agent prints `review.md` back in the reply and offers the rest.

## Layout

```
agent/
├── agent.ts            root agent: routes, never reviews
├── instructions.md     system prompt
├── hooks/usage.ts      per-call cost ledger
├── tools/              load-pr · pr-debator · export-review
├── lib/                pure logic: review.ts (seats, prompts, verdict) · pr.ts (sources, git) · usage.ts
└── subagents/          ava · cole · nova · reba · dex · iris · quinn — all hidden, all sharing the root's sandbox
```

`lib/usage.ts` and `lib/usage-hook.ts` were copied from the former spec debate implementation. `packages/agents/README.md` says shared logic belongs in `@aspiralabs/config`; moving them there changes a published package's public API, so it is recorded as debt in the spec rather than done here.

The package directory is what selects the agent — eve loads the one root agent under the app root it finds from the working directory, and `-C` sets that directory for you. `pnpm --filter @aspiralabs/pr-reviewer exec eve ...` works too, but only from inside the monorepo; see `packages/agents/README.md`.
