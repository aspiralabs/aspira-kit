---
'@aspiralabs/ai': patch
---

build-feature and worktree fixes from the NOMNOMZZ NOM-43 run:

- **The test step reads AGENTS.md correctly (KIT-77).** With no `gates` in aspira.json, it now takes the per-change sentence ("Shipping to dev needs …") when AGENTS.md has one. It skips commands marked release-only or prod-only, and commands meant for another app.
- **The fix stage's allowed files are wider (KIT-73).** A fix may now edit test files the branch already changed, such as an integration suite. Citations with line suffixes (`a.ts:42`, `a.ts:10-20`, `a.ts:27,31`) now match their file.
- **A step's pull no longer refuses files the run itself pulled (KIT-72).** Every pull records a hash of each file it wrote (`.pulled.json`). A file that still holds exactly the last pull is overwritten without `--force-pull`. The code analyzer never fixes or formats `.work/`, `.worktrees/` or `.codebase-map/`.
- **A step report with null times keeps its usage (KIT-80).** Null fields count as not reported instead of throwing the whole usage away. Step skills under `--parent-run` still record the subagents they launch.
- **The Build Summary stops listing unchanged answers as deviations (KIT-79).** A groomer answer whose tick carries a plain "(recommended)" note is no longer reported as "changed from X to X".
- **Worktrees and `kit init` keep aspira.json (KIT-78).** A run started inside a worktree links the main checkout's aspira.json before reading it. `kit init` in a worktree with no aspira.json links the main checkout's file and updates it instead of writing a bare one. The "no Aspira project here" message names `kit init`.
- **A fresh worktree runs `prisma generate` (KIT-75).** It runs after the install in an app with a Prisma schema and a prisma dependency.
- **Launchers find the global kit without PATH (KIT-76).** When `kit` is not on PATH, the launchers look in `$PNPM_HOME`, `~/Library/pnpm` and `~/.local/share/pnpm`, then ask pnpm. If they still can't find it, the error says how to fix PATH.
