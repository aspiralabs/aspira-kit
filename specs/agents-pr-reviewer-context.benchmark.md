# pr-reviewer context: benchmark

Both runs reviewed the same commit of nomnomzz PR #2, head `e7e4a60` against base `5ed8b29` (68 files, 12,448 changed lines), in default (cloud) mode through the AI Gateway, six Opus 5.5 seats and Quinn on GPT-6 Luna. The new run used a draft PR (#3) at that commit with comment posting off. Kit at `4f3eeca` (PRs #42, #45, #46, #47, #48).

## Numbers

| | 2026-10-05, before | 2026-10-06, after |
| --- | ---: | ---: |
| Model calls | 328 | 110 |
| Input tokens | 18,134,355 | 4,446,410 |
| Cache-read share | 89% | 82% |
| Cache writes | 2,063,909 | 791,547 |
| Output tokens | 291,761 | 81,573 |
| Rounds | 4 (round cap) | 2 (stopping rule) |
| Wall clock | 28m 52s | 7m 56s |
| Cost | $12.57 | $5.03 |
| Packet at the start of every prompt | none (seats read files one by one) | 7,403 tokens (changed-file index) |

Cost is 40% of the original, calls a third, wall clock 27%.

## What produced the saving

- The stopping rule ended the review after two rounds; the original ran to the four-round cap because seats waited for fixes to land.
- The packet is an index of the changed files (path, change size, area, symbols touched), not the diff. Seats fetch only the hunks their lens needs, in one batched call. On this PR the index is 7,403 tokens; the first attempt at a packet, the whole diff, was 184,766 tokens and cost $12.09 for round one alone.
- The packet and the shared instructions are the identical system prompt for every seat, so the cache write is shared. Round-one writes still total 430,988 tokens because each seat then writes its own fetched hunks; those are per seat by design.

## Findings

Severity profile is the same: no critical, no high. The sets differ.

| | Before (posted comment) | After |
| --- | --- | --- |
| Medium | 3 | 4 |
| Low | 8 | 6 |
| Info | 1 | 0 |

Found by both, in substance: the stale build notes naming functions that no longer exist (DEX1.4 before, DEX1.2 after); mobile lists re-fetching on focus (raised in a later round before, COLE1.1 after, where the after run found the precise cause: every loaded page is re-downloaded, not page one).

Found only after: keyset sorts with no matching index and an empty query running `ILIKE '%%'` (COLE1.2); the mobile list logic copied into three screens without the web's stale-cursor restart (NOVA1.1); the fresh-session path list hard-coded in `betterRoute` (NOVA1.2); the transport module depending on the auth client (NOVA1.3); the search route building its SQL twice (NOVA1.4); hand-built "Try again" controls on mobile (IRIS1.1); fixed sleeps in the account-switch e2e test (REBA1.2).

Found only before: the `/cookbooks/mine` endpoint read through two different schemas so the cache could drop the image field (NOVA1.1 before, the strongest medium of that run); `gcTime: 0` throwing away loaded pages on back navigation (COLE1.1 before); mobile lists retrying failed pages three times in production (REBA1.1 before); the sort control showing "Relevance" while results came back newest (DEX1.3 before); the sentinel with no `rootMargin` (COLE1.4 before).

Reading: the after run spends its budget on fewer, deeper reads and found more structural problems; the before run, reading more files, found more behavioural bugs that need two files side by side (the two-schema cache bug needs `recipe-save.tsx` and `cookbook-card.tsx` together). Neither set is a superset. A `--since` re-review on the fixed commits is the next measurement.

## Cost of getting here

Two launches before this one failed on first contact (a workflow bundle import, then a missing persona file in the snapshot) and one capped launch ran a full round at $12.09 because the budget check is per stage. Spent on failed or capped launches on 2026-10-06: about $25. Both failure classes now have tests (`workflow-bundle.test.ts`, `launch-files.test.ts`).
