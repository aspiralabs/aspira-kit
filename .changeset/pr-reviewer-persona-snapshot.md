---
'@aspiralabs/kit': patch
---

pr-reviewer launches again: `load-pr` read each seat's `persona.md` (and previous reviews' `cost.md`) from a path built from its own module location, which at launch is eve's compiled snapshot under `.eve/dev-runtime/snapshots/…`, where no authored file exists, so every run died in `load-pr`. Host-side reads now resolve the real package directory from the snapshot location (`agent/lib/package-dir.ts`), and a new test builds eve's own snapshot plan for the package and requires every file the runtime opens at launch to exist where the runtime will look, so a renamed or forgotten file fails in CI rather than on the first run.
