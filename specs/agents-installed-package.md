# Agents and skills are consumed as an installed package, never from a source checkout

## Intent

Today the six `/aspira-*` skills on a machine are symlinks from `~/.claude/skills/` into one source checkout of this repository, and each launcher finds its agent through `<AGENT>_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/<agent>`, then its own location. In the NOM-4 run ten checkouts of the kit sat on disk, `ASPIRA_KIT` pointed at a stale one, and the session exported overrides on every call. The decision (2026-10-06): a project consumes the agents and skills as versioned packages, like `@aspiralabs/ui` and `@aspiralabs/config`. Updating an agent means a kit change, a release, and a dependency bump in the project. The source checkout is for developing the kit, nothing else.

## Acceptance criteria

### Features

- [ ] F1: **The agent packages publish.** `@aspiralabs/agent-common`, `@aspiralabs/spec-writer`, `@aspiralabs/spec-reviewer`, `@aspiralabs/planner`, `@aspiralabs/implementor`, `@aspiralabs/code-analyzer` and `@aspiralabs/pr-reviewer` leave the changesets `ignore` list and join the `fixed` group with `@aspiralabs/ui`, `@aspiralabs/config` and `@aspiralabs/kit`, so every release ships all ten at one version. Each has `private` removed, a `files` list that ships `agent/`, `skill/`, `scripts/` and any built output, and `publishConfig` for GitHub Packages like the other three. `pnpm test` at the root packs them with the rest.
- [ ] F2: **One meta-package for projects.** A new `@aspiralabs/agents` package depends on the six agent packages and `agent-common` at the same version and ships nothing else. `kit init` adds it as a devDependency of the project. A project then has every agent under `node_modules/@aspiralabs/<agent>/`.
- [ ] F3: **Skills install into the project.** `kit init` writes `.claude/skills/aspira-<agent>/` for each agent as a thin copy of the package's `skill/aspira-<agent>/` folder (`SKILL.md` and `scripts/`), and records the kit version in `.claude/skills/aspira-<agent>/.kit-version`. A re-run after a bump rewrites them; `kit doctor` fails when a skill folder is missing or its recorded version differs from the installed `@aspiralabs/agents` version. The skills are committed to the project (they are small and version-pinned), so every clone and every teammate has the same ones. The `~/.claude/skills/aspira-*` symlinks are no longer the installation method; the kit README says how to remove them.
- [ ] F4: **Launchers resolve the installed package first.** Every `scripts/<agent>.sh` resolves its agent as: `<AGENT>_AGENT_DIR` when set (kit development only, and the run's report says so), else `node_modules/@aspiralabs/<agent>` walking up from the project root, else its own package location. `$ASPIRA_KIT` is no longer consulted. A launcher that resolves to a source checkout prints one line saying it is running kit source at `<path>`, not the installed version.
- [ ] F5: **The agent runtime works from `node_modules`.** The agents' `start` path (eve, `.env.local`, Docker sandbox) and `local` path (Node, `--experimental-strip-types`) run from the installed location: no path assumes a workspace layout, `pnpm-workspace.yaml`, or a sibling package. Agent environment files are read from the project (`.env.local` at the project root, then the agent's own folder), so a project's `AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `KNOWLEDGE_PAGE` serve every agent.
- [ ] F6: **Versions are visible.** `kit doctor` prints the installed version of `@aspiralabs/agents` beside the other three, and every skill's report and every run's trace record the agent package version that ran.

### Tests

- [ ] unit: launcher resolution order on a fixture tree (env override, installed package, own location), and the "running kit source" line.
- [ ] unit: `kit init` writes the six skill folders with `.kit-version`; `kit doctor` fails on a missing folder and on a version mismatch; passes after re-init.
- [ ] integration: `pnpm pack` of each agent package, installed into a scratch project with `kit init`, runs `planner.sh local <fixture spec> --guidelines <fixture>` through its `knowledge` stage from `node_modules` with no `ASPIRA_KIT` set.
- [ ] integration: the release workflow's dry run (`changeset version` on a fixture changeset) bumps all ten packages together.

## Implementation and verification plan

- Changesets config and package manifests first (no behavior change), then the meta-package, then `kit init` and `kit doctor`, then the launchers.
- Check each agent for workspace-relative paths (`../../`, `packages/`, `pnpm-workspace.yaml`) and replace them with package-relative resolution from `import.meta.url`.
- Run every package's `test`, `typecheck` and `lint`, and the root `pnpm check`, which packs everything.

## Out of scope

Publishing to the public npm registry. Changing any agent's behavior.
