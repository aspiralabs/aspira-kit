#!/bin/bash
# The /aspira-worktree launcher: runs `kit worktree` from the global @aspiralabs/ai with the
# arguments it was given, relays its output and exits with its code. It has no rules of its own.
set -euo pipefail

NAME=worktree
die() { echo "aspira-$NAME: $*" >&2; exit 1; }
# The project is found from the working directory only (this script lives in ~/.claude/skills, not in
# a project): the nearest aspira.json at or above it.
dir=$PWD
while [ ! -f "$dir/aspira.json" ]; do
  [ "$dir" != / ] || die "no Aspira project here (no aspira.json at or above $PWD)"
  dir=$(dirname "$dir")
done
# Only the global kit (pnpm add -g @aspiralabs/ai) on PATH runs; a project's own node_modules copy is never used.
KIT=$(command -v kit) || die "cannot find kit: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update"
exec "$KIT" "$NAME" "$@"
