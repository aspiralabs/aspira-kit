---
'@aspiralabs/build-feature': patch
'@aspiralabs/kit': patch
---

The slowest build-feature test files are split by describe block so CI shards finish together, and two kit tests (`kit worktree` T49, `kit cleanup` T31) no longer depend on running as a non-root user. The reusable `kit-checks` workflow takes a `runs-on` input for the runner label (default `ubuntu-latest`).
