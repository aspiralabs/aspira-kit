# @aspiralabs/ui

## 0.2.1

### Patch Changes

- 068f42c: `InputDate` imports `dayjs/plugin/customParseFormat.js` with its extension. dayjs has no `exports` map, so the bare subpath only resolved under a bundler; strict ESM resolution (Node, vitest with the package externalized) failed with `ERR_MODULE_NOT_FOUND`.

## 0.2.0

### Minor Changes

- 239e049: Port the improvements the products made to their local copies of the core components (spec: `specs/product-drift-port.md`).

  Fixes: `Input` no longer loops when given an inline `mask={{...}}` in controlled mode (mask options are keyed by contents; sync writes are not echoed back, and the guard is one-shot so clearing a field is still reported); `InputDate` ignores imask's transient re-emits in controlled mode; `Form` no longer crashes on a `Textarea` without a `name`; floating panels open above drawers; `InputSelect` no longer trips Radix's "uncontrolled to controlled" warning when an uncontrolled select gets its first selection.

  Additive: `Form` renders a `FormProvider` (`useFormContext()` works inside it); `Drawer` `size` measures the card and is clamped to the viewport; `DataTable` gains `loading` / `skeletonRows`; `DataInfiniteTable`'s loading state hugs its skeleton rows; `Input type="password"` gets a show/hide toggle; `Section` gains `divider`; `Page.Header` config gains `description`; `InputSelect` warns in development when two options stringify to the same value (Radix compares values as strings, so one of them could never be selected).

  New: `InputAddress`, a Mapbox-autocompleted street field that fills sibling city/state/zip/lat/lng form fields. The token is a prop.

### Patch Changes

- 239e049: `@aspiralabs/ui`: the 43 JSX ternaries that came over from SAAS_BOILER are rewritten (lookup maps, early-return helpers, precomputed props) and the package-level lint exemption is removed, so the org's no-ternary rule now holds inside the ui package. No rendered output changes. `@aspiralabs/config`: first two agent guides, `table-pagination` and `choosing-a-selector`.

## 0.1.0

### Minor Changes

- d898b86: Initial release: the ui library with tokens, docs, and MCP server; shared eslint, tsconfig, prettier, and agent config; the kit CLI.
