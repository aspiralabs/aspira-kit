---
'@aspiralabs/ai': minor
---

Ticket worktrees are isolated: each gets its own database branch, dev server and webhooks, set up by `kit worktree` (rerun it to resume a failed step) and torn down after the merge or by `kit cleanup`. New `kit dev` starts the worktree's dev server, which visual verify uses, and `kit db migrate --name <n>` runs migrations against the worktree's own database.
