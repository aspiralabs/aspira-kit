# Slop register

Every review comment that repeats is a guardrail nobody wrote yet. Log the pattern here with a count. At three, it becomes a lint rule in `@aspiralabs/config/eslint`, a type in `@aspiralabs/ui`, or a hook, and the entry moves to "promoted."

## Open

(nothing)

## Promoted

- Ternaries in JSX -> `no-restricted-syntax` selector (2026-09-19, from RULES.md). The 43 that came over from SAAS_BOILER across 17 files were rewritten and the `@aspiralabs/ui` override removed (2026-09-19); the rule now holds in the ui package too.
- Raw form elements -> `no-restricted-syntax` selector (2026-09-19)
- Palette colors -> `aspiralabs/no-palette-colors` (2026-09-19)
- PascalCase file names -> `unicorn/filename-case` (2026-09-19)
