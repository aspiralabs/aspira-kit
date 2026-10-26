#!/bin/bash
# The /aspira-cleanup launcher: runs `kit cleanup` from the global @aspiralabs/ai with
# the arguments it was given, relays its output and exits with its code. It has no rules of its own.
set -euo pipefail

NAME=cleanup
die() { echo "aspira-$NAME: $*" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# The project root: the nearest aspira.json at or above this script (installed under
# <root>/.claude/skills/aspira-<name>/scripts/), else the folder that holds .claude/.
project_root() {
  local dir=$here
  while :; do
    if [ -f "$dir/aspira.json" ]; then printf '%s\n' "$dir"; return 0; fi
    [ "$dir" != / ] || break
    dir=$(dirname "$dir")
  done
  (cd "$here/../../../.." && pwd -P)
}
ROOT=$(project_root)
# In a multi-app repository `kit init --app` records the app that owns package.json and
# node_modules in the root's aspira.json; the kit is installed there, else at the root.
APP=""
[ ! -f "$ROOT/aspira.json" ] || APP=$(sed -nE 's/.*"app"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/aspira.json" | head -n 1)
OWNER=$ROOT
if [ -n "$APP" ] && [ "$APP" != . ]; then OWNER="$ROOT/$APP"; fi
# A project copy from an earlier kit wins; otherwise the global install (pnpm add -g @aspiralabs/ai) on PATH.
KIT="$OWNER/node_modules/.bin/kit"
[ -x "$KIT" ] || KIT=$(command -v kit) || die "cannot find kit: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit init"
exec "$KIT" "$NAME" "$@"
