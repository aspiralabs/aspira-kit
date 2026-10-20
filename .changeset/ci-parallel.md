---
'@aspiralabs/build-feature': patch
'@aspiralabs/kit': patch
---

Tests no longer depend on each other. build-feature's tests run concurrently within a file (each builds its own fixture, and temp folders are removed once per file), and the kit's install test does its one `kit init` in setup instead of in its first test. The reusable `kit-checks` workflow now runs build, lint, typecheck and each test shard as separate parallel jobs; a product keeps today's behaviour by default and can pass `prepare` and `test-shards` to narrow the pre-build and shard its tests.
