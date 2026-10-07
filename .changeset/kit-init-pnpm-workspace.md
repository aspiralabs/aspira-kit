---
'@aspiralabs/kit': patch
---

`kit init --app` works in a workspace whose root has its own package.json (pnpm-workspace.yaml or a "workspaces" field): it uses the root's `.npmrc`, lockfile, allowBuilds and prettier config instead of writing copies into the app, and moves any @aspiralabs packages the root declares to the same version as the app's. `kit doctor` flags a root kit package on another version. Repositories with no root package.json work exactly as before. The kit now reads JSON with comments and trailing commas, so a commented tsconfig.json no longer stops init or doctor.
