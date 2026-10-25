---
'@aspiralabs/ai': patch
---

The global `kit` no longer hands commands to a project's own copy from an earlier kit, so `kit init` in a project that still has one removes it instead of running the old version. `kit init` with no `--app` works on the app `aspira.json` records.
