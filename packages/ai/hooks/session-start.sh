#!/bin/sh
# SessionStart hook, matchers startup|resume|clear|compact. Puts the pointer to
# the org rules and the process in context at the start of a session and again
# after every compaction. The rules themselves live in Notion, not in a file.
# Claude Code reads stdout as JSON only when it is exactly one object, so that is
# all that is printed: the pointer as additionalContext and, once a day when a
# newer @aspiralabs/ai exists, the upgrade notice as systemMessage.
rules() {
  cat <<'TXT'
<!-- @aspiralabs/ai session-start hook -->
Aspira Labs: the engineering rules and the process live in Notion. Look them up; do not answer from memory.
- Rules: Engineering Central > Agent Instructions, https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. Fetch it with the Notion MCP before any code change and follow its table to the topic pages.
- The flow and what comes next: AI-DLC > From Idea to Release, https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea (Playbook: the ticket's Status picks the step).
- Component docs: the aspiralabs-ui MCP server (get_component before writing component markup).
- Project facts and Gotchas: this repository's AGENTS.md, outside the managed block.
TXT
}
escaped=$(rules | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN { ORS = "\\n" } { print }')
notice=$(node "$(dirname "$0")/../dist/cli.js" version-check 2>/dev/null || true)
message=""
if [ -n "$notice" ]; then
  message=",\"systemMessage\":\"$notice\""
fi
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}%s}\n' "$escaped" "$message"
exit 0
