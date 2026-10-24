# Aspira Kit

This repo is the Aspira Labs engineering organization, as code. One version across the three packages:

- `packages/ui` is `@aspiralabs/ui`: components, tokens, component docs, and the MCP server that serves them.
- `packages/config` is `@aspiralabs/config`: eslint, tsconfig and prettier as subpath exports. Nothing else.
- `packages/ai` is `@aspiralabs/ai`: the `kit` CLI at the package root that installs the others into a project by stack, one folder per agent (`groomer`, `spec-writer`, `planner`, `implementor`, `code-analyzer`, `pr-reviewer`; `build-feature` and `visual-verify` are skill-only, with no eve agent; `spec-reviewer` is the review library the spec writer runs, with no skill of its own since KIT-48), and `common/` for what they share. A project consumes it installed, never from this checkout; the source is for developing the kit.

Rules for working here are the org rules in Notion: Engineering Central › Agent Instructions, https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. Read it first. The process is AI-DLC › From Idea to Release, https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea.

Every change to a published package needs a changeset (`pnpm changeset`). Versions are lockstep.
