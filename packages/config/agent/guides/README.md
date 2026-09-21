# Guides

Reference material agents look up when a task calls for it, as opposed to constraints, which are always in context. One file per topic. Frontmatter with `date`, `tags`, `applies-to` (stack or package).

- `table-pagination.md`: which table or picker to use for a data set, and the two response shapes (cursor vs. offset) they expect.
- `choosing-a-selector.md`: ChoiceBox, ToggleBox, SegmentedControl, InputSelect, Checkbox: which one, decided by option count, descriptions, and whether the pick is a filter.

Layout patterns are not a guide: they ship as docs inside `@aspiralabs/ui` (`docs/patterns/*.mdx`) and are served by the `aspiralabs-ui` MCP server's `get_pattern` tool. Product-specific structure (auth, data model) belongs in the product's own guides, not here.
