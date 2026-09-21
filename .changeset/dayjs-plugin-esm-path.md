---
"@aspiralabs/ui": patch
---

`InputDate` imports `dayjs/plugin/customParseFormat.js` with its extension. dayjs has no `exports` map, so the bare subpath only resolved under a bundler; strict ESM resolution (Node, vitest with the package externalized) failed with `ERR_MODULE_NOT_FOUND`.
