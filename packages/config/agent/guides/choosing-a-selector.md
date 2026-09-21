---
date: 2026-09-19
tags: [forms, selection, components]
applies-to: "@aspiralabs/ui"
---

# Choosing a selector

Five components let a user pick from a set. The choice is about how many options there are, whether they need explaining, and whether the choice is a setting or a filter. Call `get_component` on the winner before writing markup.

| Situation | Use | Not |
|---|---|---|
| 2 to 4 mutually exclusive options that each need a sentence (plan tiers, tone, delivery method) | `ChoiceBox` (`mode="single"`) | A `Select` that hides the descriptions, or a hand-rolled card grid |
| The same, but several may be on at once | `ChoiceBox mode="multi"` | A column of `Checkbox`es with paragraph labels |
| One boolean that deserves a title and description (a feature flag, a consent) | `ToggleBox` | A bare `Switch` next to a paragraph |
| A short list of terse, equal-weight choices that change a view (grid/list, month/year) | `SegmentedControl` | Tabs (those change the page, not a view) or a `Select` |
| 5 or more options, or options that are data (users, cities, tags) | `InputSelect` | `ChoiceBox` (it does not scroll or search) |
| Options come from an API or the list is long enough to search | `InputSelect searchable` or `dataMode="remote"` | Fetching the whole list into `options` |
| A pick that filters a table rather than fills a form | `InputSelect triggerVariant="badge"`, or a `StandardToolbar` filter dimension | An input-shaped select above a table |
| A single yes/no inside a dense form row | `Checkbox` or `Switch` | `ToggleBox` (too tall for a form row) |

## Tie-breakers

- **Descriptions decide.** If every option needs explaining, it is a `ChoiceBox`. If none do, it is a `Select` or `SegmentedControl`.
- **Scroll decides.** `ChoiceBox` renders every option; past four the page gets long and the comparison the cards exist for is lost.
- **Data decides.** Options that are records (with ids) go through `InputSelect`, which understands `labelKey`/`valueKey`, `entryRender`, and remote paging (see `table-pagination.md`).
- **Form decides.** Inside `<Form>` every one of these is a controlled field by `name`; the wrapper spreads `onChange`/`value` from its Controller. Do not add local state around them.
- Both `ChoiceBox` and `ToggleBox` filter clicks that originate in an `aria-hidden` descendant. That is a Radix BubbleInput workaround, not a hook for custom content; do not put interactive children inside a card.

## Adding a variant

If none fits, the answer is a variant on the nearest component (a new `size`, a `triggerVariant`) in `@aspiralabs/ui`, with a doc section and a changeset. Not a local component in the product.
