---
'@aspiralabs/kit': patch
---

`kit init` approves pnpm build scripts in `pnpm-workspace.yaml` (`onlyBuiltDependencies`), the place pnpm 12 reads, instead of the `pnpm` field of package.json, which pnpm 12 ignores.
