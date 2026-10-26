---
name: aspira-cleanup
description: Remove the .work/ folders and ticket worktrees of Released or Dropped tickets by running `kit cleanup`, after listing them and getting a yes in chat. Use for /aspira-cleanup or requests to clean up finished tickets, old working folders or worktrees.
---

# Clean up finished tickets

This skill is a launcher for `kit cleanup` and has no rules of its own. `kit cleanup` decides what is deleted, kept or skipped from each card's live Status; this file covers only the confirmation in chat and the session's own folder.

Use the absolute path to `scripts/cleanup.sh` beside this file. The launcher runs the global kit (the `kit` on PATH), not a kit under the project's app; it prints what `kit cleanup` prints and exits with its code.

## 1. List

```bash
<skill-dir>/scripts/cleanup.sh
```

Without `--yes` and without a terminal, `kit cleanup` lists every candidate (path, ticket, live Status, verdict) and deletes nothing. Relay the listing as it is. When it says nothing to delete, stop there.

## 2. Confirm in chat

Ask the human whether to delete every path the listing marked `delete`, naming how many folders and worktrees. Anything but a clear yes deletes nothing: say so and stop.

## 3. Leave a worktree that is about to go

If the session's working directory is inside a ticket worktree the listing marked `delete`, move out of it before deleting:

- When this session entered that worktree with `EnterWorktree`, call `ExitWorktree` and keep the worktree (do not remove it; `kit cleanup` does).
- Otherwise (the session started inside the worktree, so no switch is offered), work from the main checkout's absolute path for the rest of the session, and tell the human their shell or session started in a folder cleanup removes and to reopen in `<main checkout path>`.

## 4. Delete what was confirmed

From the main checkout, rerun with exactly the paths the listing marked `delete`:

```bash
<skill-dir>/scripts/cleanup.sh --yes --only <every path listed as delete>
```

Relay what the rerun did: deleted, kept, skipped, failed, already gone, and any `not confirmed` lines (a card whose Status changed, or a candidate that appeared, after the listing; it is left in place for the next run). Report the exit code: 1 means a marked deletion failed or there is no board.
