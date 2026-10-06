# @aspiralabs/agent-common

Tools and pure helpers shared by the eve agents under `packages/agents/`. Source-only, published with the kit: an agent adds it as a workspace dependency and mounts a tool by re-exporting it from its own `agent/tools/`, which is where eve discovers tools. `lib/agent-version` is how every --local driver names the agent package that ran and records it in an export's trace.

```ts
// packages/agents/<agent>/agent/tools/load-knowledge.ts
export { default } from '@aspiralabs/agent-common/tools/load-knowledge'
```

Tool names stay unprefixed and each agent chooses what it mounts. Pure helpers live in `src/lib/` with their tests next to them; `pnpm test` here runs them once, not once per agent.

## Tools

| Tool | What it does |
| --- | --- |
| `board` | The project's Feature Board through `lib/board`: `resolve` a ticket; `start` gates the skill on the ticket's Status, pulls its pages into `<repo>/.work/<id>-<slug>/` and claims it; `finish` pushes the skill's outputs as child pages and makes the success move. The skill launchers run the same flow on the host around a run (`lib/ticket-cli`), so an agent calls it only when its request says the ticket was not claimed. Needs `NOTION_TOKEN` and `<repo>/aspira.json`. |
| `load-knowledge` | Loads the org's engineering guidelines from Notion into the sandbox at `/workspace/knowledge` as markdown, one file per page, with `INDEX.md` as the entry point. Walks child pages from the page named in `KNOWLEDGE_PAGE` using `NOTION_TOKEN`. Returns `{ configured: false }` rather than failing when either is unset, so an agent runs without guidelines instead of not at all. Also writes `REQUIRED.md`, the pages every agent must read in full (`KNOWLEDGE_REQUIRED`, default "Agent Instructions, Review Verification"), and throws when one is not in the tree; returns its path as `requiredFile`. |

## Board and markdown helpers

Two pure modules under `src/lib/`, imported as `@aspiralabs/agent-common/lib/board` and `@aspiralabs/agent-common/lib/notion-markdown`. They are F3 and F4 of `specs/agents-ticket-flow.md`; the skills, drivers and `kit next` build on them and never call the Notion API themselves.

| Module | What it does |
| --- | --- |
| `board` | `board({ board, token?, api?, request? })` returns the one client that talks to a product's Feature Board (a Notion data source, read from the project's `aspira.json`; the token defaults to `NOTION_TOKEN`). `resolveTicket(idOrUrl)` takes `NOM-4` in any case, a bare number, or a page URL and returns the ID, title, URL, Status, Type, Priority, Area, Dev, PR, Version, the Idea body as plain markdown and the child pages by title. `moveTicket(page, from, to)` sets Status and refuses when the current Status is not `from`. `setProperty(page, name, value)` sets Dev, PR or any other property the board has. `pushPage(page, title, markdown)` creates the child page with that title or replaces the content of the existing one (same URL). `pullPage(page, title)` returns the child page as plain markdown, or undefined when there is none. Reads the board schema once, retries on 429, and throws `BoardError` with Notion's status and message. |
| `notion-markdown` | `notionToMarkdown` turns Notion markdown (the markdown endpoint and the MCP) into plain markdown: escapes removed, `<table>` to pipe tables, callouts to block quotes, mentions to links, and every block the plain form cannot hold becomes an html comment naming its type. `markdownToBlocks` turns plain markdown (headings 1 to 3, paragraphs, bulleted and numbered lists, to-dos, fenced code with language, pipe tables, block quotes, dividers, bold, italic, strikethrough, inline code, links) into Notion API blocks, with rich text chunked at 2000 characters. `blocksToMarkdown` renders blocks back. A round trip of the NOM-4 reviewed spec and plan (`src/lib/fixtures/notion/`) changes nothing. |

Their tests run against recorded Notion API shapes in `src/lib/fixtures/board/` served by an in-process mock server, so `pnpm test` never reaches Notion.

## The ticket flow

Four modules under `src/lib/` carry F1, F5 to F8 and F10 of the same spec, once for the six skills:

| Module | What it does |
| --- | --- |
| `ticket` | Pure. The gate table (`GATES`: which Status each skill runs from, its start and success moves, the pages it pushes with their fixed titles, its input file), `checkGate`, `endMove` and `pushesFor`; the page-to-file map (`TICKET_PAGES`); `renderTicketMd` and `parseTicketMd` for `.work/<id>-<slug>/ticket.md`; `pullDecision` (keep an unchanged file, refuse a newer local file without `--force-pull`); `ticketArgument` (ID, URL, the one working folder, or a path with `--no-ticket`); `reportHeader`. |
| `ticket-flow` | On a file system and a board. `startFlow` and `finishFlow` perform the flow through `lib/board` for a separate-process run; `localBoardStep`, `localBoardEnd` and `localBoardVerify` list the same actions as data for a `--local` session and verify `ticket.md` between steps. Both write `trace/board.json` with every action and the Status before and after. `readAspira`, `findWorkFolders`, `inputFileFor`. |
| `ticket-driver` | What every `scripts/local.ts` does around its `runLocal`: `beforeRun` (the board stage or the ticket and its input file), `afterRun` (the end actions and the trace) and `verifyRun` (`--verify`). |
| `ticket-cli` | The `start`, `finish` and `resolve` commands the launchers run through each agent's `scripts/ticket.ts`, printing `key=value` lines; exit 3 is a refusal. `scripts/resolve-ticket.ts` is the same `resolve` for `kit next`. |

eve's own way to share capabilities is an extension package (`eve extension build`, mounted under `agent/extensions/`, tools prefixed with the mount name). This package is the lighter form of the same idea; move to an extension if these tools are ever published outside the monorepo.
