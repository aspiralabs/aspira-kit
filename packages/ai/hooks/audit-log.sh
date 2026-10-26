#!/bin/sh
# PreToolUse hook. One JSON line per tool call. The log answers: which agent,
# which tool, what input, when, on which branch. The log lives at the project
# root (the directory Claude Code runs in, which it names CLAUDE_PROJECT_DIR),
# never beside this script, which kit init copies into .claude/hooks/aspira/. It is
# written only where git ignores .aspira/ (or there is no git repository).
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
log="${ASPIRA_AUDIT_LOG:-$dir/.aspira/audit.jsonl}"
if [ -z "$ASPIRA_AUDIT_LOG" ] && git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 \
  && ! git -C "$dir" check-ignore -q .aspira/audit.jsonl 2>/dev/null; then
  echo "aspira audit log skipped: .aspira/ is not ignored by git" >&2
  exit 0
fi
mkdir -p "$(dirname "$log")"
branch=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null || echo "-")
printf '{"ts":"%s","branch":"%s","event":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "$input" >> "$log"
exit 0
