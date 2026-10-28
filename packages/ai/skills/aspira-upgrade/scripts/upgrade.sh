#!/bin/bash
# The /aspira-upgrade launcher: runs `kit upgrade` from the global @aspiralabs/ai with the
# arguments it was given, relays its output and exits with its code. It has no rules of its own.
set -euo pipefail

NAME=upgrade
die() { echo "aspira-$NAME: $*" >&2; exit 1; }
# The project is found from the working directory only (this script lives in ~/.claude/skills, not in
# a project): the nearest aspira.json at or above it, else the git repository's top level, since a pull
# of the commit that stopped tracking aspira.json deletes it and kit upgrade restores it.
dir=$PWD
while [ ! -f "$dir/aspira.json" ]; do
  if [ "$dir" = / ]; then
    dir=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || die "no Aspira project here (no aspira.json at or above $PWD, and not in a git repository)"
    break
  fi
  dir=$(dirname "$dir")
done
# Only the global kit (pnpm add -g @aspiralabs/ai) runs; a project's own node_modules copy is never used.
# On PATH, else in pnpm's global bin, which Claude Code's Bash PATH can lack (KIT-76): $PNPM_HOME, ~/Library/pnpm (macOS),
# ~/.local/share/pnpm (Linux), each with or without bin/, then `pnpm bin -g`.
find_kit() {
  local base dir
  command -v kit 2>/dev/null && return
  for base in "${PNPM_HOME:-}" "$HOME/Library/pnpm" "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm" "$(command -v pnpm >/dev/null 2>&1 && pnpm bin -g 2>/dev/null)"; do
    [ -n "$base" ] || continue
    for dir in "$base" "$base/bin"; do
      if [ -x "$dir/kit" ]; then printf '%s\n' "$dir/kit"; return; fi
    done
  done
  return 1
}
KIT=$(find_kit) || die "cannot find kit: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update; if it is installed, add pnpm's global bin to PATH (export PATH=\"\$HOME/Library/pnpm:\$PATH\" in your shell profile) and restart Claude Code"
cd "$dir"
exec "$KIT" "$NAME" "$@"
