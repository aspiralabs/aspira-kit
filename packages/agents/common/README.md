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
| `load-knowledge` | Loads the org's engineering guidelines from Notion into the sandbox at `/workspace/knowledge` as markdown, one file per page, with `INDEX.md` as the entry point. Walks child pages from the page named in `KNOWLEDGE_PAGE` using `NOTION_TOKEN`. Returns `{ configured: false }` rather than failing when either is unset, so an agent runs without guidelines instead of not at all. Also writes `REQUIRED.md`, the pages every agent must read in full (`KNOWLEDGE_REQUIRED`, default "Agent Instructions, Review Verification"), and throws when one is not in the tree; returns its path as `requiredFile`. |

eve's own way to share capabilities is an extension package (`eve extension build`, mounted under `agent/extensions/`, tools prefixed with the mount name). This package is the lighter form of the same idea; move to an extension if these tools are ever published outside the monorepo.
