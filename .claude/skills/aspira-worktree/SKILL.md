---
name: aspira-worktree
description: Create (or reuse) the git worktree for a Feature Board ticket at .worktrees/<TYPE>-<ID> on its branch by running `kit worktree`, then continue this session there. Use for /aspira-worktree or requests to start a ticket in its own worktree or to work two tickets side by side.
argument-hint: <ticket ID>
---

# A worktree for a ticket

This skill is a launcher for `kit worktree` and has no rules of its own. `kit worktree` decides the path, the branch, and whether it may create one; this file covers only running it and moving the session.

## Run

Use the absolute path to `scripts/worktree.sh` beside this file:

```bash
<skill-dir>/scripts/worktree.sh <ticket ID>
```

The launcher runs the kit installed under the project's app (`app` in `aspira.json`, else the root), prints what `kit worktree` prints and exits with its code. Relay the output as it is. On exit 1 or 2 (a refusal, a failed install or build, or a bad ID), relay it and stop; when install or build failed, the worktree it names still exists. Exit 1 can also name a failed isolation step (its own database branch, dev server or webhooks); the worktree stays, and running `kit worktree` again resumes the missing steps, so say so. When it reused a branch it did not make here under today's name, it prints that branch's last commit and a `skip` line instead of installing: relay both, and never pass `--install` or run the install yourself; the human reads the branch first and decides.

## Move the session

On exit 0 the output ends with the worktree's absolute path and its branch. Continue the session there:

- When the session offers Claude Code's worktree switch (`EnterWorktree`) and it can enter that existing path, use it.
- Otherwise work from that absolute path for the rest of the session: run commands there and edit files under it.

Either way, tell the human that the CLAUDE.md, skills and settings this session loaded at start are those of the original checkout, not the worktree's; a new session opened in the worktree loads its own.
