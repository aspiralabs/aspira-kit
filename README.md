# Aspira Kit

The Aspira Labs development kit. One repo that says everything the organization says about how software gets built, shipped as versioned packages so every project is on a known version of the rules.

| Package | What | Install |
|---|---|---|
| `@aspiralabs/ui` | Components, `tokens.css`, component docs (MDX), and an MCP server that serves those docs to agents | `pnpm add @aspiralabs/ui` |
| `@aspiralabs/config` | `eslint/next`, `eslint/base`, `eslint/library`, `tsconfig/*`, `prettier`, and `agent/*` (constraints, guides, hooks, personas, templates) | `pnpm add -D @aspiralabs/config` |
| `@aspiralabs/kit` | The CLI. `kit init --stack next` wires a project; `kit doctor` reports its kit version and drift | `pnpm add -D @aspiralabs/kit` |

All three are published to **GitHub Packages** under the `aspiralabs` org and versioned in lockstep: one version number across the kit.

## Use the kit in an app

GitHub Packages needs a token to install, even for public packages. Once per machine:

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Export it: `export NPM_TOKEN=ghp_...` (put it in your shell profile, or in CI as a secret).

Then in the project:

```bash
# .npmrc  (kit init writes this for you)
@aspiralabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

```bash
pnpm add -D @aspiralabs/kit
pnpm kit init --stack next        # installs ui + config, writes eslint/prettier/tsconfig wiring,
                                  # globals.css imports, AGENTS.md, CLAUDE.md, .mcp.json, hooks, specs/
pnpm kit doctor                   # what version you are on, what is wired
```

What `init` leaves you with, if you would rather do it by hand:

```css
/* app/globals.css */
@import "tailwindcss";
@import "@aspiralabs/ui/tokens.css";
@source "../node_modules/@aspiralabs/ui/dist";   /* Tailwind must scan the package for classes */
@source "../node_modules/@aspiralabs/ui/docs";

:root {
  --primary: #0057ff;   /* override any token */
  --radius: 0.5rem;
  --radius-on: 1;       /* 1 rounded, 0 square */
}
```

```tsx
import { Button, Card, Input } from '@aspiralabs/ui'
```

```js
// eslint.config.mjs
import next from '@aspiralabs/config/eslint/next'
export default next
```

```json
// tsconfig.json
{ "extends": "@aspiralabs/config/tsconfig/next.json", "compilerOptions": { "paths": { "@/*": ["./*"] } } }
```

```json
// .mcp.json  (component docs for agents, version-locked to what you installed)
{ "mcpServers": { "aspiralabs-ui": { "command": "npx", "args": ["--no", "aspiralabs-ui-mcp"] } } }
```

Dark mode is class-based (`dark` on `<html>`, for example with `next-themes`). Fonts are the app's job: the tokens reference `--font-mono` and `--font-serif`, and the sans face is whatever the app sets on `<body>`.

## Develop the kit

```bash
pnpm install
pnpm dev            # ui in tsc --watch plus the docs site on http://localhost:3100
pnpm check          # typecheck, lint, build, smoke tests, for every package
```

`apps/docs` is the design-system site. It renders the MDX that ships inside `@aspiralabs/ui`; it is never a second copy of the docs.

## CI and releases

**Every pull request and every push to `main`** runs `ci.yml`: install, typecheck, lint, build, and the smoke tests (the MCP server answers over stdio; each package packs cleanly). `main` is protected: changes land by pull request and the `ci` check must pass.

**Releases are decoupled from merges.** You can merge as many PRs into `main` as you like before cutting a release.

1. In a PR that changes a package, run `pnpm changeset`, pick the bump (patch, minor, major), write one line. That file is the release note. A PR that does not need a release note (docs site, CI, refactors with no behavior change) skips this and merges normally.
2. On every merge to `main`, `release.yml` looks for pending changesets. If there are any, it opens or updates **one** pull request titled "Release: version packages" that bumps all three packages in lockstep and writes the changelogs. That PR stays open and accumulates as more changesets merge.
3. **Cutting a release is merging that PR.** The workflow then builds, publishes all three packages to GitHub Packages, tags `v<version>`, and creates a GitHub Release from the changelog. It uses the built-in `GITHUB_TOKEN`; there are no personal tokens in the publish path.

The published packages appear at https://github.com/orgs/aspiralabs/packages.

## Layout

```
packages/ui        @aspiralabs/ui        src/components, src/primitives, src/layout, tokens.css, docs/*.mdx, bin/mcp.js
packages/config    @aspiralabs/config    eslint/, tsconfig/, prettier/, agent/
packages/kit       @aspiralabs/kit       src/cli.ts, src/stacks/next.ts, src/doctor.ts
apps/docs          the design-system site (private, not published)
.github/workflows  ci.yml, release.yml, kit-checks.yml (reusable; products can call it)
.changeset         lockstep config and pending changesets
```

Why this shape: the enforcement ladder. Every engineering decision is pushed as far up the ladder as it can go (instruct, look up, detect, check, structure, gate), and the packages carry the rungs to every repo.
