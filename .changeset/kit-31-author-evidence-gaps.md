---
'@aspiralabs/spec-reviewer': patch
---

An evidence gap the author answered in the spec, naming the source and quoting the fact, is resolved by the author (KIT-31). The reviewer has no web, Notion or cloud tools, so a gap whose source lives outside the repository could never be closed and a rerun stayed incomplete for good. The synthesis now records such a gap as `author` in `gapResolutions` with the spec's own words as evidence; it no longer blocks readiness, and `trace/findings.md` lists these gaps under "Evidence gaps resolved by the author" for the human approving the spec. A gap with no such answer still blocks.
