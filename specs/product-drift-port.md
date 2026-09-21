# Port product drift into @aspiralabs/ui

Status: approved (2026-09-19, verbal, D. Ludemann)

## Intent

Four products forked SAAS_BOILER's `components/ui` and improved it independently. Bring the bug fixes and additive features back into `@aspiralabs/ui` so every product on the kit gets them, and so the products can drop their local copies.

Sources: PET_WASTE_CRM (Sep 4), RECIPES/NOMNOMZZ (identical, Sep 9-10), LISTPILOT (May 16).

## In scope

Bug fixes
- `Input`: stable mask options (`maskKey`) and sync echo guard; inline `mask={{...}}` in controlled mode no longer loops. (RECIPES)
- `InputDate`: controlled-mode echo guard against imask's transient re-emits. (PET_WASTE_CRM)
- `Form`: only bind a `Textarea` that has a `name`. (PET_WASTE_CRM, RECIPES)
- `floating-panel-primitive`: z-index above drawer/modal so panels opened inside a drawer are not clipped. (both)

Additive
- `Form`: wrap in `FormProvider` so nested components can `useFormContext()`. (both)
- `Drawer`: `size` sizes the inner card, clamped to the viewport; drop hardcoded `w-3/4` / `max-h-[80vh]`. (both)
- `DataTable`: `loading`, `skeletonRows`. (both)
- `DataInfiniteTable`: loading state hugs skeleton rows; `queryKey: unknown[]`. (RECIPES)
- `Input`: password visibility toggle. (LISTPILOT)
- `Section`: `divider` prop; renders `<section>`. (RECIPES)
- `PageHeaderConfig.description`. (RECIPES)
- New `InputAddress`: Mapbox street autocomplete that fills sibling form fields. Token comes in as a prop, not from `process.env`; the package has no framework dependency. `Form` binds it by `displayName`. (PET_WASTE_CRM)

## Out of scope

- `WizardDrawer` (product composition, stays in PET_WASTE_CRM).
- RECIPES' `Page` variant/width redesign. The product wraps the core `Page`.
- Product styling: `rounded-full` buttons, calendar hover, table radius, section gap, LISTPILOT's square SegmentedControl, `menu-class-names`.

## Acceptance

- `pnpm check` passes; no JSX ternaries (the lint rule now holds in ui).
- Each changed component's MDX documents the new prop or behavior.
- `InputAddress` has a doc and is listed by the MCP server.
- Rendered output of unchanged props is unchanged (Drawer sizing is the one visible change and is intended).

## Blast radius

`@aspiralabs/ui` only, minor bump. `Drawer`'s `size` (default 500) now measures the inner card rather than the outer positioner, so cards are 32px wider than before at the same `size`; the card is clamped to the viewport.
