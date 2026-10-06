# @aspiralabs/agent-common

Tools and pure helpers shared by the eve agents under `packages/agents/`. Source-only and private: an agent adds it as a workspace dependency and mounts a tool by re-exporting it from its own `agent/tools/`, which is where eve discovers tools.

```ts
// packages/agents/<agent>/agent/tools/load-knowledge.ts
export { default } from '@aspiralabs/agent-common/tools/load-knowledge'
```

Tool names stay unprefixed and each agent chooses what it mounts. Pure helpers live in `src/lib/` with their tests next to them; `pnpm test` here runs them once, not once per agent.

## Tools

| Tool | What it does |
| --- | --- |
| `load-knowledge` | Loads the org's engineering guidelines from Notion into the sandbox at `/workspace/knowledge` as markdown, one file per page, with `INDEX.md` as the entry point. Walks child pages from the page named in `KNOWLEDGE_PAGE` using `NOTION_TOKEN`. Returns `{ configured: false }` rather than failing when either is unset, so an agent runs without guidelines instead of not at all. Also writes `REQUIRED.md`, the pages every agent must read in full (`KNOWLEDGE_REQUIRED`, default "Agent Instructions, Review Verification"), and throws when one is not in the tree; returns its path as `requiredFile`. |

## Board and markdown helpers

Two pure modules under `src/lib/`, imported as `@aspiralabs/agent-common/lib/board` and `@aspiralabs/agent-common/lib/notion-markdown`. They are F3 and F4 of `specs/agents-ticket-flow.md`; the skills, drivers and `kit next` build on them and never call the Notion API themselves.

| Module | What it does |
| --- | --- |
| `board` | `board({ board, token?, api?, request? })` returns the one client that talks to a product's Feature Board (a Notion data source, read from the project's `aspira.json`; the token defaults to `NOTION_TOKEN`). `resolveTicket(idOrUrl)` takes `NOM-4` in any case, a bare number, or a page URL and returns the ID, title, URL, Status, Type, Priority, Area, Dev, PR, Version, the Idea body as plain markdown and the child pages by title. `moveTicket(page, from, to)` sets Status and refuses when the current Status is not `from`. `setProperty(page, name, value)` sets Dev, PR or any other property the board has. `pushPage(page, title, markdown)` creates the child page with that title or replaces the content of the existing one (same URL). `pullPage(page, title)` returns the child page as plain markdown, or undefined when there is none. Reads the board schema once, retries on 429, and throws `BoardError` with Notion's status and message. |
| `notion-markdown` | `notionToMarkdown` turns Notion markdown (the markdown endpoint and the MCP) into plain markdown: escapes removed, `<table>` to pipe tables, callouts to block quotes, mentions to links, and every block the plain form cannot hold becomes an html comment naming its type. `markdownToBlocks` turns plain markdown (headings 1 to 3, paragraphs, bulleted and numbered lists, to-dos, fenced code with language, pipe tables, block quotes, dividers, bold, italic, strikethrough, inline code, links) into Notion API blocks, with rich text chunked at 2000 characters. `blocksToMarkdown` renders blocks back. A round trip of the NOM-4 reviewed spec and plan (`src/lib/fixtures/notion/`) changes nothing. |

Their tests run against recorded Notion API shapes in `src/lib/fixtures/board/` served by an in-process mock server, so `pnpm test` never reaches Notion.

eve's own way to share capabilities is an extension package (`eve extension build`, mounted under `agent/extensions/`, tools prefixed with the mount name). This package is the lighter form of the same idea; move to an extension if these tools are ever published outside the monorepo.
