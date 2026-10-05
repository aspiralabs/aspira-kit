# @aspiralabs/kit

## 0.4.0

## 0.3.0

### Minor Changes

- 9e1b4e5: `kit add auth` writes a base Better Auth setup into a Next.js project: server config, client, session helpers, auth emails, Redis and Prisma clients, the route handler, and `.env.example` keys. Options: `--no-passkey`, `--expo <scheme>`. Existing files are kept. CLI errors now print one line instead of a stack trace.

## 0.2.1

## 0.2.0

### Patch Changes

- adcc8e7: `kit init` writes a registry-only `.npmrc` and points at `~/.npmrc` for the token, since pnpm 12 does not expand `${VAR}` in `.npmrc`. `--dry-run` no longer writes files.

## 0.1.0

### Minor Changes

- d898b86: Initial release: the ui library with tokens, docs, and MCP server; shared eslint, tsconfig, prettier, and agent config; the kit CLI.
