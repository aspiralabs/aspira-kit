#!/bin/sh
# PreToolUse hook. One JSON line per tool call. The log answers: which agent,
# which tool, what input, when, on which branch. The log lives at the project
# root (the directory Claude Code runs in, which it names CLAUDE_PROJECT_DIR),
# never beside this script: in a multi-app repository the script sits under
# <app>/node_modules while the session runs at the root.
input=$(cat)
log="${ASPIRA_AUDIT_LOG:-${CLAUDE_PROJECT_DIR:-.}/.aspira/audit.jsonl}"
mkdir -p "$(dirname "$log")"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-")
printf '{"ts":"%s","branch":"%s","event":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "$input" >> "$log"
exit 0
