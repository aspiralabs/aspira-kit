#!/bin/sh
# SessionStart hook, matchers startup|resume|clear|compact. Prints the org
# constraints so they are in context at the start of a session and again after
# every compaction. Reads from the installed package, so the version matches.
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
f="$root/node_modules/@aspiralabs/config/agent/constraints.md"
if [ -f "$f" ]; then
  echo "<!-- @aspiralabs/config constraints, injected by session-start hook -->"
  cat "$f"
fi
exit 0
