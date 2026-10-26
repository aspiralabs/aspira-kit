#!/bin/sh
# SessionStart hook, matchers startup|resume|clear|compact. Puts the pointer to
# the org rules and the process in context at the start of a session and again
# after every compaction. The rules themselves live in Notion, not in a file.
# Claude Code reads stdout as JSON only when it is exactly one object, so that is
# all that is printed: the pointer as additionalContext and, once a day when a
# newer @aspiralabs/ai exists, the upgrade notice as systemMessage.
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
rules() {
  cat <<'TXT'
<!-- @aspiralabs/ai session-start hook -->
Aspira Labs: the engineering rules and the process live in Notion. Look them up; do not answer from memory.
- Agent Instructions (the rules): Engineering Central > Agent Instructions, https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. Fetch it with the Notion MCP before any code change and follow its table to the topic pages.
- From Idea to Release (the flow and what comes next): AI-DLC > From Idea to Release, https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea (Playbook: the ticket's Status picks the step).
- Writing back: a mistake a rule would have prevented goes to the AI Agent Slop Repo, https://app.notion.com/p/bc25fc5cf5464f2593c7a0b663d6f859; a gap in a kit agent or in @aspiralabs/ui goes to the Aspira Kit gap pages linked from Agent Instructions.
- Component docs: the aspiralabs-ui MCP server (call get_component before writing component markup).
- Agents: the /aspira-* skills run the kit's agents.
- Lint, types and formatting come from @aspiralabs/config; run pnpm check before opening a PR.
- Project facts and Gotchas: this repository's AGENTS.md.
TXT
}
escaped=$(rules | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN { ORS = "\\n" } { print }')
# kit init copies this hook into .claude/hooks/aspira/; the version check is the global kit's. In the
# package itself (kit development) the package's own cli runs it.
cli="$(dirname "$0")/../dist/cli.js"
if [ -f "$cli" ]; then
  notice=$(node "$cli" version-check 2>/dev/null || true)
else
  notice=$(kit version-check 2>/dev/null || true)
fi
message=""
if [ -n "$notice" ]; then
  message=",\"systemMessage\":\"$notice\""
fi
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}%s}\n' "$escaped" "$message"
exit 0
