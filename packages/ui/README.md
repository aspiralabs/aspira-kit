# @aspiralabs/ui

Components, tokens, component docs, and an MCP server that serves those docs to agents. The docs ship inside the package so an agent on version 1.4 gets 1.4's docs.

## Use

```css
/* app/globals.css */
@import "tailwindcss";
@import "@aspiralabs/ui/tokens.css";
@source "../node_modules/@aspiralabs/ui/dist";

:root {
  --primary: #0057ff;   /* override any token */
  --radius: 0.5rem;
  --radius-on: 1;       /* 1 rounded, 0 square */
}
```

```tsx
import { Button } from '@aspiralabs/ui'
<Button variant="secondary">Add customer</Button>
```

## MCP server

`aspiralabs-ui-mcp` (stdio). Registered by `kit init` in `.mcp.json`. Tools: `list_components`, `get_component`, `search`, `get_tokens`, `get_pattern`. Reads `docs/*.mdx`, `docs/patterns/*.mdx`, and `tokens.css` from the installed package.

## Migration from SAAS_BOILER

`Button` is migrated as the pattern. One change on the way in: `rounded-none` became `rounded-md` so radius tokens reach buttons (square by default since `--radius-on` is 0).

```bash
node scripts/migrate-component.mjs badge     # copies component + doc, rewrites imports
```

Remaining, in rough dependency order (leaves first): icon, badge, skeleton, alert, avatar, card, keyboard-shortcut, tooltip, switch, checkbox, textarea, input, input-otp, slider, segmented-control, toggle-box, choice-box, scroll-area, virtualized-scroll-area, color-picker, editable-text, input-select, input-date, menu, modal, drawer, form, toast. Then `primitives/` (11 Radix wrappers) and `tables/` (two data tables; these import `next/navigation` and need the router passed in).

Known coupling to break as they come over: `@/lib/utils` (done, `lib/cn.ts`), `@/components/ui/core/icon` (16 importers; migrate icon early), `next/navigation` (tables, option-picker).

Audit on the way in: `rounded-*` literals, `text-[..px]`, hex values, palette classes. The lint config will flag the last two.
