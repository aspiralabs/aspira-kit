---
'@aspiralabs/agent-common': patch
'@aspiralabs/spec-writer': patch
'@aspiralabs/spec-reviewer': patch
'@aspiralabs/planner': patch
---

A repository file over the index size budget no longer ends a run incomplete (KIT-29). The index names every file it left out for size in the evidence packet ("Not indexed (size budget): <path>"), so the model reads it directly when the work touches it; the spec writer, spec reviewer and planner no longer turn those notes into problems. Before, every run on a repository with one tracked file over 256 KB ended incomplete whatever the output said.
