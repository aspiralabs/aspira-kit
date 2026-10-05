# Agent skills: one pattern for every agent

## Intent

Every Aspira agent can be run two ways with the same behavior and the same rules: as the agent itself (a separate process), or inside a Claude Code session with `--local`. The agent is the single source of truth. Its skill only calls it, and `--local` reuses the agent's own instruction files and prompt builders at runtime, so editing an agent changes its skill automatically. Every path loads the Notion engineering rules; none may run without them.

## Acceptance criteria

### Features

- [ ] F1: Every agent in `packages/agents/` that a person runs (spec-writer, spec-reviewer, planner, implementor, code-analyzer, pr-reviewer) has a skill at `packages/agents/<agent>/skill/aspira-<agent>/` with `SKILL.md` and `scripts/<agent>.sh`. By default the skill launches the agent as a separate process (`start`, `status`, `wait`). With `--local`, it runs the agent's pipeline in the session.
- [ ] F2: `--local` never launches the agent and never calls a model from the script. A `local` step driver prints the stage and its tasks, and writes each task's prompt to a file, then validates outputs against the agent's own schemas and advances. Each prompt is assembled when the step runs from the agent's own files: `agent/instructions.md`, `agent/subagents/*/instructions.md`, and the prompt and schema modules in `agent/lib/`. It never uses a copy. An agent with no subagent pipeline (its work is tool calls plus one model loop, as in code-analyzer) runs its loop with the session acting as the model, using the same instructions file.
- [ ] F3: `SKILL.md` contains no agent rules. It describes only mechanics: which command to run, how to launch the listed tasks as subagents (in parallel where the driver says so), and what to report. It names `agent/instructions.md` as the authority for the rules. A test per skill asserts that key rule sentences from that agent's `instructions.md` are absent from `SKILL.md` and that `SKILL.md` references the instructions file.
- [ ] F4: The Notion engineering rules are mandatory on every path. The default path loads them as the agent does now (`load-knowledge` or a `--guidelines` snapshot). In `--local`, the driver prints a `knowledge` stage listing the exact Notion pages the agent's own knowledge configuration would load: the required pages and the topic pages they route to. The session fetches them with the Notion MCP into `<work>/knowledge/` (`REQUIRED.md`, `INDEX.md`, one file per page), or a `--guidelines` snapshot is used. The driver refuses to start without them. Prompts get the same knowledge section the agent gives its subagents. The export records which rules were used, and a change to the knowledge folder mid-run is refused.
- [ ] F5: Tests cover each agent:
  - a prompt file embeds the current byte content of the instruction file it comes from, and changes when that file changes;
  - the driver refuses to start without knowledge;
  - the knowledge page list comes from the agent's configuration, not the skill.
- [ ] F6: `packages/agents/README.md` and `INSTRUCTIONS.md` document the pattern once: skill = launcher, `--local` = same pipeline in the session from the agent's own files, Notion rules mandatory. Every new agent must follow it.

## Implementation and verification plan

- `pr-reviewer` is the reference (`specs/agents-pr-reviewer-local.md`).
- Bring `spec-reviewer` and `spec-writer` in line: their `--local` already exists, so audit them for copied text and the knowledge flow.
- Add `--local` to `planner` and `code-analyzer`. code-analyzer also accepts a subdirectory, so repos with several apps and no root `package.json` can be analyzed.
- Give `implementor` a skill directory that follows the pattern; its current skill lives in `agent/skills/`.
- Each agent implements its driver in its own package first (parallel work, no shared-file conflicts); shared helpers (knowledge stage, fingerprinting, prompt-file assembly) may be extracted to `packages/agents/common` afterwards.
- For each agent, run its package's `test`, `typecheck` and `lint`.

## Out of scope

Changing any agent's prompts, models or pipeline behavior beyond what `--local` needs.
