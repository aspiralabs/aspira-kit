---
'@aspiralabs/ai': minor
---

`@aspiralabs/ai` is installed globally only (`pnpm add -g @aspiralabs/ai`), never as a project dependency. `kit init` no longer adds it, and removes one an earlier kit added; `kit doctor` fails while a project declares it. The `/aspira-*` launchers run the agents from the global install (found with the new `kit package-dir`), blocked with "run kit init" when a skill's `.kit-version` differs from it. The hooks are copied into `.claude/hooks/aspira/` and `.claude/settings.json` runs them from there, so nothing points into `node_modules/@aspiralabs/ai`. To move a project: `pnpm add -g @aspiralabs/ai@latest`, then `kit init` in the project, and commit `package.json`, the lockfile and `.claude/`.
