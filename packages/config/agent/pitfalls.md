# Pitfalls

Things that have bitten us. Each entry: what happened, why, what to do instead, date.

- **Tailwind v4 does not see classes inside packages.** A product must add `@source "../node_modules/@aspiralabs/ui/dist";` to its CSS or the package's markup renders unstyled. `kit init` writes this line. (2026-09-19)
- **A token override only reaches what reads the token.** `Button` in SAAS_BOILER hardcoded `rounded-none`, so `--radius-on: 1` rounded everything except buttons. Audit `rounded-*`, `text-[...]`, and hex values in components before assuming overrides work. (2026-09-19)
- **`paths` in a shared tsconfig do not work.** TypeScript resolves `paths` relative to the file that declares them, so `@aspiralabs/config/tsconfig/next.json` cannot carry `@/*`. Each project declares its own `paths`; `kit init` adds the default. (2026-09-19)
