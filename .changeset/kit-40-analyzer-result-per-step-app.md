---
'@aspiralabs/build-feature': patch
---

build-feature judges each code-analyzer step by the export under that step's own `--app` directory, commits the fixes every analyzer step recorded and lists every app's result in the PR body (KIT-40). Before, the driver read aspira.json's `app` for every analyzer step, so on a multi-app repository a stale `.static-analysis/rounds.json` under that app ended a run whose per-app steps had all finished ready.
