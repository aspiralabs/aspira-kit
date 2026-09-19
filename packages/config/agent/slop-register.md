# Slop register

Every review comment that repeats is a guardrail nobody wrote yet. Log the pattern here with a count. At three, it becomes a lint rule in `@aspiralabs/config/eslint`, a type in `@aspiralabs/ui`, or a hook, and the entry moves to "promoted."

## Open

- **JSX ternaries in @aspiralabs/ui** (49 across 17 files, migrated from SAAS_BOILER 2026-09-19). `packages/ui/eslint.config.mjs` turns `no-restricted-syntax` off for `src/**/*.tsx` until they are rewritten. Files: choice-box, input-select, toggle-box, option-picker-primitive, page-header, data-table, standard-toolbar, data-infinite-table, form-demo, tooltip, textarea, slider, menu, input, input-otp, form, editable-text.

## Promoted

- Ternaries in JSX -> `no-restricted-syntax` selector (2026-09-19, from RULES.md)
- Raw form elements -> `no-restricted-syntax` selector (2026-09-19)
- Palette colors -> `aspiralabs/no-palette-colors` (2026-09-19)
- PascalCase file names -> `unicorn/filename-case` (2026-09-19)
