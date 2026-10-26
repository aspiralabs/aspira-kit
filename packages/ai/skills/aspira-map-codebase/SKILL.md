---
name: aspira-map-codebase
description: Build or refresh the codebase map of the git repository you are in and have this session's subagents propose notes about it, by running `kit map-codebase`. Use for /aspira-map-codebase or requests to map the codebase, refresh the map, check whether the map is fresh, or propose map notes.
argument-hint: [--check | brief <target> | notes [accept|retire <note-id>]]
---

# Map the codebase

This skill is a launcher for `kit map-codebase` and has no rules of its own. The map is a per-repo record of files, packages and import edges that agents query for what a change touches and what depends on it. It works in any git repository and needs no aspira.json.

## Run

Use the absolute path to `scripts/map-codebase.sh` beside this file, from inside the repository:

```bash
<skill-dir>/scripts/map-codebase.sh [--check | brief <target>... [--json] | notes]
```

- No argument builds or refreshes the map and prints the map root, the commit and the counts.
- `--check` says fresh, stale (with the changed files) or missing; exit 1 when it is not fresh.
- `brief <target>` prints the bounded packet for a path, package, symbol, env var or changed files. A brief is orientation only: verify with source reads.

The launcher runs the global kit (the `kit` on PATH), prints what `kit map-codebase` prints and exits with its code. A non-zero exit is the answer: relay it, do not retry.

## Propose notes

Notes are authored statements about the code that a later brief can show. Drive them as steps:

1. Run `<skill-dir>/scripts/map-codebase.sh notes`. With nothing pending it prints one JSON object `{ "stage": "step", "task": ..., "output": ... }`.
2. Launch one subagent with the `task` text, plus these two sentences: it may read the repository (Read, Grep, Glob) and nothing else, and it must not run `notes accept` or `notes retire`. It writes its JSON to `output`.
3. Run the same `notes` command again. It stores each proposal as a candidate note and prints each new note's id, title and text as stored (redacted).
4. Print those ids, titles and texts to the human.

A candidate note is shown in no brief. Accepting one is the human's command, `kit map-codebase notes accept <note-id>`: this session and its subagents never run `accept`, and never `retire` either unless the human asks for that note by id.
