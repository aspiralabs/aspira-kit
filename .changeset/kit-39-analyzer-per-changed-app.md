---
'@aspiralabs/build-feature': patch
---

build-feature runs the code analyzer once per app directory the implementor's record says it changed, each with its own `--app`, and treats static analysis as done only when every one of them ended ready (KIT-39); aspira.json's `app` is used only when the record names no app. Before, the analyzer ran on aspira.json's `app` alone, so on a multi-app repository a ticket's changes in other packages were never analyzed and a kit-only app directory with nothing to lint ended the step incomplete.
