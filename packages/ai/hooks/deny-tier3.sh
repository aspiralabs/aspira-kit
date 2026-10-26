#!/bin/sh
# PreToolUse hook (Claude Code and Codex share the JSON shape). Denies tier-3
# actions regardless of permission mode. Exit 2 blocks; stderr is shown to the agent.
# Acts only in an Aspira project: walk up from the project directory to its git top-level
# (else HOME) looking for aspira.json; anywhere else this hook is silent.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
stop=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$HOME")
here=$(cd "$dir" 2>/dev/null && pwd -P || echo "$dir")
while :; do
  [ -f "$here/aspira.json" ] && break
  [ "$here" = "$stop" ] || [ "$here" = "/" ] && exit 0
  here=$(dirname "$here")
done
input=$(cat)
cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

deny() { echo "DENIED (tier 3): $1. This action needs a named human." >&2; exit 2; }

case "$cmd" in
  *"git push"*" main"*|*"git push"*" master"*|*"git push --force"*|*"git push -f"*) deny "push to a protected branch" ;;
  *"prisma migrate"*|*"prisma db push"*) deny "database migration" ;;
  *"rm -rf"*) deny "recursive delete" ;;
esac

case "$path" in
  *.env*|*/prisma/migrations/*|*/.github/*) deny "edit to protected path $path" ;;
esac
exit 0
