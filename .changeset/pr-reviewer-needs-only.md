---
'@aspiralabs/kit': patch
---

pr-reviewer's shared packet is an index of the change, not the change. It holds the PR description, `REQUIRED.md`, and one line per changed file with its path, added and deleted lines, an area tag from its path (api, db-migration, web-ui, mobile, lib, test, e2e, docs, config, infra) and the symbols its hunks touch; no diff hunks and no file bodies, so on nomnomzz PR #3 (68 files, 12,448 changed lines) it is under 15,000 tokens instead of 185,000. Each seat picks the files its lens needs from the index and fetches their hunks with the new `read_diff(paths)` tool and the surrounding code with `read_files(paths)`, one batch each, into its own context; Quinn fetches only what findings cite. The packet-wide character cap and the per-file excerpt rule are gone (file truncation stays in `read_files` and `read_diff`), and `--local` maps `read_diff` to the work directory's `pr.patch`.
