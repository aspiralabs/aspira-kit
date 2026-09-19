# Aspira Kit

This repo is the Aspira Labs engineering organization, as code. Three packages, one version:

- `packages/ui` is `@aspiralabs/ui`: components, tokens, component docs, and the MCP server that serves them.
- `packages/config` is `@aspiralabs/config`: eslint, tsconfig, prettier, and agent config (constraints, guides, hooks, personas) as subpath exports.
- `packages/kit` is `@aspiralabs/kit`: the CLI that installs the others into a project by stack.

Rules for working here are the org rules: `packages/config/agent/constraints.md`. Read it first.

Every change to a published package needs a changeset (`pnpm changeset`). Versions are lockstep.
