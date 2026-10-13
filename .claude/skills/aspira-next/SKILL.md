---
name: aspira-next
description: Say what the next step is for a Feature Board ticket, from its Status, by running `kit next`, then offer to run that step's /aspira-* command and run it on a yes. Use for /aspira-next or questions like "what's next for KIT-12", "what do I run now", "where is this ticket in the flow".
argument-hint: [<ticket ID>]
---

# What is next for a ticket

This skill is a launcher for `kit next` and has no rules of its own. The Playbook in `@aspiralabs/kit` (the "Playbook: what to run next" section of From Idea to Release) decides the step; this file covers only running it and acting on its answer.

## Run

Use the absolute path to `scripts/next.sh` beside this file, from the project the session works in:

```bash
<skill-dir>/scripts/next.sh [<ticket ID>]
```

With an ID it looks that ticket up on the board. Without one, `kit next` uses the one folder under `.work/` that holds a `ticket.md`; with none or several it says to name the ticket. The launcher runs the kit installed under the project's app (`app` in `aspira.json`, else the root), prints what `kit next` prints and exits with its code.

## Relay, then offer

1. Relay the `ticket`, `status`, `next`, `run` and `who` lines as they are.
2. Offer to run the step only when the launcher exited 0 and the `run` line is a command (it starts with `/aspira-`). Ask in chat: "Run `<command>` now?".
3. If the command holds a placeholder other than the ticket ID, such as `<app-dir>`, fill it before offering: `<app-dir>` is the `app` in the project's `aspira.json`; when there is none or the value is unclear, ask the human. Never offer or run a command that still has a literal `<...>` in it.
4. On a yes, invoke that `/aspira-*` skill in this session with the command's arguments. On anything else, run nothing.
5. When the `run` line is `by hand, on the board`, or the launcher exited 1 (the ticket did not resolve, no board, or a Status the Playbook does not know), relay that and offer nothing.
