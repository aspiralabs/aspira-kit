---
"@aspiralabs/ai": minor
---

The planner stops re-reading what research already read.

- A plan change may cite its evidence as `path#symbol`: the checker finds the symbol in the file, so planning no longer opens files only to copy a line number.
- Research lists every file the change touches (`touches`: operation, symbols, line window, why), and planning writes its changes from that list.
- Planning and repair get the source packet's index (paths and line counts) instead of the whole packet, and are told research is settled evidence.
- When the spec's source spans two or more areas of the repository, explorers read the areas in parallel before research (`stage: "explore"` in the session, parallel calls in the cloud), and research builds on their findings. `planner.explore` in aspira.json `models` sets their model and effort.
