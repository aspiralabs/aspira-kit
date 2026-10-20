---
'@aspiralabs/planner': patch
'@aspiralabs/spec-reviewer': patch
---

Planner (KIT-34): the planning prompt lists the decisions research already raised and forbids raising them again under other words, planning the recommended option, so research and planning never take opposite answers to one question under `--take-recommended`. Under `--local`, planning may read the repository read-only to settle a fact before naming it (a plan gap is only for evidence it could not read), and may make the Aspira UI catalog reads itself when its plan touches UI files, recorded in its own reads file that the catalog check merges. Spec reviewer: the header strip on a rerun also removes the spec writer's own "Spec writer status" header, so a reviewed spec never carries "author decisions pending" into the planner.
