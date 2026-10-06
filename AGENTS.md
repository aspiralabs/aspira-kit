# Aspira Kit

This repo is the Aspira Labs engineering organization, as code. Three packages, one version:

- `packages/ui` is `@aspiralabs/ui`: components, tokens, component docs, and the MCP server that serves them.
- `packages/config` is `@aspiralabs/config`: eslint, tsconfig and prettier as subpath exports. Nothing else.
- `packages/kit` is `@aspiralabs/kit`: the CLI that installs the others into a project by stack.

Rules for working here are the org rules in Notion: Engineering Central › Agent Instructions, https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. Read it first. The process is AI-DLC › From Idea to Release, https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea.

Every change to a published package needs a changeset (`pnpm changeset`). Versions are lockstep.
