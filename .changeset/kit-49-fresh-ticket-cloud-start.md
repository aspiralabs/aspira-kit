---
'@aspiralabs/agent-common': patch
'@aspiralabs/build-feature': patch
---

A build-feature run starts a fresh ticket from any Status, cloud mode included (KIT-49). The cloud `start` of a step skill now pulls a ticket that has no ticket.md yet into the run's own working folder instead of refusing `--parent-run` (the --local path already did since KIT-21); the driver creates its stage output directory before printing a stage (the worktree stage's did not exist); and the ticket worktree gets the main checkout's root and app `.env.local` linked in before the install, as `kit worktree` does.
