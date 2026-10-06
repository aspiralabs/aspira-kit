#!/bin/sh
# PreToolUse hook. One JSON line per tool call. The log answers: which agent,
# which tool, what input, when, on which branch.
input=$(cat)
log="${ASPIRA_AUDIT_LOG:-.aspira/audit.jsonl}"
mkdir -p "$(dirname "$log")"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-")
printf '{"ts":"%s","branch":"%s","event":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "$input" >> "$log"
exit 0
