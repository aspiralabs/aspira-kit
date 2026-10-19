---
'@aspiralabs/agent-common': patch
'@aspiralabs/build-feature': patch
---

A build-feature run on a fresh ticket reaches its first step (KIT-21). A step skill run with `--parent-run` now finds the build-feature folder of a ticket that has no `ticket.md` yet (`.work/<id>/` holding the run state) and resolves the ticket into it, instead of refusing with "the ticket has no working folder yet". The worktree stage runs the project's install and build in the `app` directory `aspira.json` names, not only at the worktree root.
