// The one research rule every Aspira agent, phase and subagent works under (KIT-54, David:
// "the skills should be able to review the code. If it's missing information or something is
// vague, research it. Research it in the code, or Notion, or anywhere. 'unknown' should only
// happen when the skill has exhausted its research."). The same sentence goes into every
// in-session task prompt and every cloud agent's instructions.md, so a gap means the same thing
// everywhere: a source that was looked for and could not be settled, never one nobody opened.

/** The rule, as one paragraph. Every prompt that can report a gap, an unknown or an unverified fact carries it verbatim. */
export const RESEARCH_RULE =
  'Research before you report a gap: anything missing or vague is looked up first, in the repository\'s code (read the files, not just the file map), in Notion (any page or database the guidelines, the ticket, the idea or the spec point to: Approved Technologies, ADRs, decision pages, the Feature Board) and in public documentation, whichever can settle it. What you were given (a packet, a snapshot, a record, an exploration) is a head start, not a wall. "Unknown", "unverified" or a gap is allowed only once that research is exhausted, and it names where you looked and why that did not settle it.'

/** The first clause of the rule: what a docs test checks for, so an instructions file that carries the rule in full passes and one that dropped it fails. */
export const RESEARCH_RULE_MARKER = 'Research before you report a gap'

/**
 * How a Claude Code session maps the research tools, for a task prompt the session runs as a
 * subagent: the repository read tools, the Notion MCP read tools (pages, searches and database
 * rows) and the web, each with the citation a read leaves behind.
 */
export const sessionResearchTools = (repo: string): string =>
  `In this session the research tools are: Read, Grep, Glob and non-mutating git commands in the repository at ${repo}; the Notion MCP read tools (notion-fetch for a page or a database, notion-search to find one by title, notion-query-data-sources for a database's rows); WebFetch and WebSearch for public documentation. Never a write. Cite each read as file:line, a Notion page or database title with the quoted line or row, or a URL with the quoted line.`

/**
 * How a cloud agent's phase maps the research tools: the repository tools, `notion_read` and
 * `notion_search` when the agent has a Notion token, and the read-only MCP connections it was
 * configured with. Used in the prompts the pipelines build for phases that have tools.
 */
export const CLOUD_RESEARCH_TOOLS =
  'Your research tools: list_files, read_files and search over the repository; notion_read for a Notion page (its markdown) or a database (its rows) by URL or id, and notion_search to find a page or database by title, when they are present; any other read tool you were given. Cite each read as path:line, a Notion page or database title with the quoted line or row, or a URL with the quoted line.'
