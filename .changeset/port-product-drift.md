---
"@aspiralabs/ui": minor
---

Port the improvements the products made to their local copies of the core components (spec: `specs/product-drift-port.md`).

Fixes: `Input` no longer loops when given an inline `mask={{...}}` in controlled mode (mask options are keyed by contents; sync writes are not echoed back, and the guard is one-shot so clearing a field is still reported); `InputDate` ignores imask's transient re-emits in controlled mode; `Form` no longer crashes on a `Textarea` without a `name`; floating panels open above drawers.

Additive: `Form` renders a `FormProvider` (`useFormContext()` works inside it); `Drawer` `size` measures the card and is clamped to the viewport; `DataTable` gains `loading` / `skeletonRows`; `DataInfiniteTable`'s loading state hugs its skeleton rows; `Input type="password"` gets a show/hide toggle; `Section` gains `divider`; `Page.Header` config gains `description`; `InputSelect` warns in development when two options stringify to the same value (Radix compares values as strings, so one of them could never be selected).

New: `InputAddress`, a Mapbox-autocompleted street field that fills sibling city/state/zip/lat/lng form fields. The token is a prop.
