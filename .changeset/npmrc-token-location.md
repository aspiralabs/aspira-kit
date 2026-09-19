---
"@aspiralabs/kit": patch
---

`kit init` writes a registry-only `.npmrc` and points at `~/.npmrc` for the token, since pnpm 12 does not expand `${VAR}` in `.npmrc`. `--dry-run` no longer writes files.
