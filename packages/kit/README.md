# @aspiralabs/kit

The CLI that puts a project on the kit.

```bash
pnpm dlx @aspiralabs/kit init --stack next      # or, once installed: pnpm kit init --stack next
pnpm kit doctor
```

`init --stack next` is idempotent. It installs `@aspiralabs/ui` and `@aspiralabs/config`, writes `eslint.config.mjs`, `prettier.config.mjs`, points `tsconfig.json` at the kit, adds the tokens import and `@source` line to `globals.css`, writes the managed block into `AGENTS.md` (your own sections are kept), `CLAUDE.md`, `.mcp.json` with the ui MCP server, `.claude/settings.json` with the session-start, deny-tier3, and audit-log hooks, and a `specs/` folder. `--dry-run` prints the plan.

`doctor` prints the kit versions the project declares and has installed, and checks each piece of wiring.

Stacks are profiles in `src/stacks/`. Add one per ecosystem as projects need it.
