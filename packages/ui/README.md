# @aspiralabs/ui

Components, tokens, component docs, and an MCP server that serves those docs to agents. The docs ship inside the package so an agent on version 1.4 gets 1.4's docs. Migrated from SAAS_BOILER on 2026-09-19: 31 components, 11 primitives, the page layout patterns, and every design-system doc.

## Use

```css
/* app/globals.css */
@import "tailwindcss";
@import "@aspiralabs/ui/tokens.css";
@source "../node_modules/@aspiralabs/ui/dist";
@source "../node_modules/@aspiralabs/ui/docs";   /* only if the app renders the docs */

:root {
  --primary: #0057ff;   /* override any token */
  --radius: 0.5rem;
  --radius-on: 1;       /* 1 rounded, 0 square */
}
```

```tsx
import { Button, Modal, DataTable } from '@aspiralabs/ui'
```

The app supplies the fonts: GT Standard (or any sans) on `<body>`, `--font-mono` and `--font-serif` as CSS variables. Dark mode is class based (`dark` on `<html>`). Mount `TooltipProviderPrimitive`, `NiceModal.Provider`, `ToasterPrimitive`, and a `QueryClientProvider` at the root, as SAAS_BOILER's `app/providers.tsx` does.

## Layout

```
src/
  components/<name>/   31 components, one folder each (alert … virtualized-scroll-area, data-table, data-infinite-table)
  primitives/          11 Radix wrappers (avatar, checkbox, dropdown-menu, floating-panel, option-picker, popover, select, sonner, switch, table, tooltip)
  layout/              Page, Section, StandardToolbar, PageHeader
  docs-helpers/        TokenSwatch, TypeScale, SemanticSwatch, FormDemo (used by the docs)
  lib/                 cn, block-ui, use-debounce, use-standard-page, use-search-params, navigate, types
  mcp/server.ts        the MCP server
docs/                  one MDX per component; patterns/ and overview/ subfolders
tokens.css             @theme mappings, type scale, :root, .dark, base layer
```

## No framework dependency

The package does not import Next. Three things changed on the way in from SAAS_BOILER:

- `DataTable` and `DataInfiniteTable` take a `navigate?: (url: string) => void` prop for row-click navigation. Default is a full page load. In Next.js pass `useRouter().push`.
- `PageHeader`'s back link is a plain `<a>`.
- `useStandardPage` reads `window.location.search` through `useSearchParams` from this package instead of `next/navigation`.

Also: `Button` uses `rounded-md` instead of the hardcoded `rounded-none` so radius tokens reach it (square by default because `--radius-on` is 0), and `Alert`'s blue and success variants use new `--alert-*` tokens with the same hex values the palette classes had.

## MCP server

`aspiralabs-ui-mcp` (stdio). Registered by `kit init` in `.mcp.json`. Tools: `list_components`, `get_component`, `search`, `get_tokens`, `get_pattern`. Reads `docs/*.mdx`, `docs/patterns/*.mdx`, and `tokens.css` from the installed package.

## Migration debt

`eslint.config.mjs` turns the JSX-ternary rule off for `src/**` (49 ternaries in 17 files came over). Tracked in `@aspiralabs/config` `agent/slop-register.md`. `scripts/migrate-component.mjs` remains for pulling a future component from SAAS_BOILER.
