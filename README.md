# Aspira Kit

The Aspira Labs development kit. One repo that says everything the organization says about how software gets built, shipped as versioned packages so every project is on a known version of the rules.

| Package | What | Install |
|---|---|---|
| `@aspiralabs/ui` | Components, `tokens.css`, component docs (MDX), and an MCP server that serves those docs to agents | `pnpm add @aspiralabs/ui` |
| `@aspiralabs/config` | `eslint/next`, `eslint/base`, `tsconfig/next.json`, `tsconfig/library.json`, `prettier`, and `agent/*` (constraints, guides, hooks, personas, templates) | `pnpm add -D @aspiralabs/config` |
| `@aspiralabs/kit` | The CLI. `kit init --stack next` wires a project; `kit doctor` reports its kit version and drift | `pnpm dlx @aspiralabs/kit init --stack next` |

Why this shape: [enforcement ladder](https://github.com/dludemann) notes in LIFE. Short version: every engineering decision is pushed as far up the ladder as it can go (instruct, look up, detect, check, structure, gate), and the packages carry the rungs to every repo.

## Develop

```bash
pnpm install
pnpm check          # typecheck, lint, build every package
pnpm changeset      # describe a change; versions are lockstep
pnpm --filter docs dev
```

## Status

Scaffolded 2026-09-19. `Button` is the first component migrated from SAAS_BOILER as the pattern; the remaining components are listed in `packages/ui/README.md`. Nothing published yet; the `@aspiralabs` npm scope is unclaimed.
