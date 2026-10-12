---
'@aspiralabs/spec-writer': patch
'@aspiralabs/spec-reviewer': patch
'@aspiralabs/planner': patch
'@aspiralabs/implementor': patch
'@aspiralabs/code-analyzer': patch
'@aspiralabs/pr-reviewer': patch
---

The skill launchers work in a repository that installs its own agents, such as the kit checkout running `/aspira-*` on itself: a launcher that finds its own package through the root `node_modules` treats it as the package, so the project (and its `.env.local`) is still the working directory's.
