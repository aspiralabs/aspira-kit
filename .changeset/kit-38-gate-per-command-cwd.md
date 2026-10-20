---
'@aspiralabs/build-feature': patch
---

The project gate runs each command in its own directory (KIT-38). `aspira.json` may list the gates, `"gates": [{ "cwd": "tools/aspira", "command": "pnpm check" }, ...]`, cwd relative to the repository and `.` by default; when present the list wins over AGENTS.md and the package.json fallback, and the gate stage carries a directory per command (`cwds`) so a multi-app repository runs each where it belongs. Before, every AGENTS.md command ran in that file's directory, which on a repository with no root package.json made every command fail at once.
