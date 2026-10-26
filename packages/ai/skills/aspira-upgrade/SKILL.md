---
name: aspira-upgrade
description: Move this repository to the global Aspira harness by running `kit update` and then `kit upgrade`: remove the skills, hooks and managed AGENTS.md block an earlier kit committed, stop tracking aspira.json, then commit on a yes in chat. Use for /aspira-upgrade or requests to migrate or upgrade a project to the global kit.
---

# Move a repository to the global harness

This skill is a launcher for `kit upgrade` and has no rules of its own. `kit upgrade` decides what is removed, untracked or restored; this file covers only the order of the commands and the two confirmations in chat. It never runs `kit init`: the stack wiring (installs, eslint, prettier, tsconfig, css) is left as the project has it.

Use the absolute path to `scripts/upgrade.sh` beside this file. The launcher runs the global kit (the `kit` on PATH), not a kit under the project's app, from the project root (the nearest `aspira.json`, else the git repository's top level, so a repository whose `aspira.json` a pull deleted still works); it prints what `kit upgrade` prints and exits with its code.

## 1. Update the global kit

```bash
kit update
```

This installs the newest `@aspiralabs/ai` globally and rewrites the skills and hooks in `~/.claude`. When it fails, relay its error and stop.

## 2. List

```bash
<skill-dir>/scripts/upgrade.sh --dry-run
```

Relay the listing as it is: each `remove`, `untrack` and `restore` line. When it says the repository is already on the global harness, say so and stop.

## 3. Confirm in chat

Ask the human whether to make those changes, naming how many paths it removes and whether it stops tracking `aspira.json` (the file stays on disk). Anything but a clear yes changes nothing: say so and stop.

## 4. Upgrade

```bash
<skill-dir>/scripts/upgrade.sh
git status --short
```

Relay what `kit upgrade` did and the `git status --short` output. `kit upgrade` commits nothing; its last line is the commit to make (`git add -A -- <paths> && git commit -m "chore: move to the global Aspira harness"`).

## 5. Commit on a second yes

Offer to run that printed command as it is. When `aspira.json` was untracked the commit takes everything staged, so point out any staged path in the `git status --short` output that is not one of the printed paths or `aspira.json`. On a yes, run it from the project root and relay the result; on anything else, leave the changes uncommitted and say so. Never push.
