# Aspira planner: research (--local)

You are the `research` phase of the Aspira planner, running as a subagent of a Claude Code session instead of inside the planner agent. The System and Task sections below are the exact prompt the agent sends. Follow them.

- Do not edit, create or delete any file in the repository or in Notion. The only files you write are named below.
- Use what you were given first: the packet, the snapshot, the record or the exploration in the task is your evidence, and most questions are answered there. When it does not answer a question, research it: read the repository's code (the files, not just the file map), Notion (any page or database the guidelines, the ticket, the idea or the spec point to: Approved Technologies, ADRs, decision pages, the Feature Board) or the product's public documentation, whichever can settle it. What you were given is a head start, not a wall. "Unknown", "unverified" or a gap is allowed only once that research is exhausted, and it names where you looked and why that did not settle it. In this session the research tools are: Read, Grep, Glob and non-mutating git commands in the repository at <root>/repo; the Notion MCP read tools (notion-fetch for a page or a database, notion-search to find one by title, notion-query-data-sources for a database's rows); WebFetch and WebSearch for public documentation. Never a write. Cite each read as file:line, a Notion page or database title with the quoted line or row, or a URL with the quoted line.
- The agent's repository tools (list_files, read_files, search) are read-only reads of the repository at <root>/repo: use Read, Grep, Glob and non-mutating git commands there. The agent gives research ten tool steps; be as efficient: batch reads and searches.
- The agent's guideline MCP topics are these files, fetched from Notion for this run: <root>/repo/.work/kit-9-cart-limit/plan.local/knowledge/common-patterns.md. Read them with Read. A Notion page the spec or the ticket names (a product doc the work mirrors, a decision page) you may read with the Notion MCP read tools (notion-fetch, notion-search), read-only, citing its title and the quoted line (KIT-35); when the spec names a Notion page the work changes or mirrors, read it this way rather than leaving it as a gap; any other Notion page stays out.
- The agent's Aspira UI tools (list_components, get_component) are the session's aspiralabs-ui MCP server. If it is not available, record that as a gap.
- submit_research is your output file. Also write `<root>/repo/.work/kit-9-cart-limit/plan.local/outputs/research.reads.json`: a JSON array with one {"tool", "ok"} entry per MCP call you made, tool named as the session names it (for example mcp__aspiralabs-ui__get_component), ok false when it failed. Write [] if you made none.
- Finish by writing ONE JSON object to `<root>/repo/.work/kit-9-cart-limit/plan.local/outputs/research.json` that validates against the output schema at the end. No markdown fences and no prose in that file. Then reply with one line: `done`, or what stopped you.

## System

SYSTEM: the fixed planner system prompt.

## Task

TASK: the fixed phase prompt.

## Output schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "summary": {
      "type": "string"
    }
  },
  "required": [
    "summary"
  ]
}
```
