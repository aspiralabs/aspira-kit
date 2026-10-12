# Groomer agent

Grooms a Feature card's Idea in rounds before it reaches Ready: Idea. Spec: KIT-8 (`.work/kit-8-*/spec.reviewed/spec.reviewed.md` while it is built).

One run is one round:

1. **round zero** (first run only, or when no facts are recorded): the fact-finder subagent searches the repository by the idea's domain concepts and reports what exists and which terms collide, each fact with file:line. It runs on `anthropic/claude-haiku-4.5`.
2. **round**: the frontier model (`anthropic/claude-opus-5.5`, override with `GROOMER_ROUND_MODEL`) composes the whole frontier of open product questions, each in the decision-rule shape, tagged with its design-tree branch and resting on recorded facts. `agent/lib/rounds.ts` validates the round (`roundSchema`) before anything is written.
3. **confirm**: when the page shows Confirm ticked and nothing open, the round model composes the Idea summary instead, validated against `groom/trace/groom.json`.

The model never touches the board. The launcher's ticket step (`scripts/ticket.ts`, the shared `ticketCli('groomer')`) resolves and gates the card, pulls Grooming Decisions, marks the page and makes the Idea -> Grooming move before the run; its finish step merges the page's ticks, replaces the page append-first, writes the Idea summary and makes the Grooming -> Shortlist move after it. The agent's tools are `load-knowledge`, `read-repository` (the shared repository snapshot and read-only MCP tools), `write-round` (only `round-<n>.json` and `idea-summary.md` under `groom/`) and the `groom` workflow; there is no board tool.

Results go to `.work/<id>-<slug>/groom/`: `round-<n>.json`, `idea-summary.md` on a confirm, `run-analysis.md` (cost and time by phase and model, so both tiers show) and `trace/` (`groom.json`, the pulled `decisions.md`, calls, usage, agent version, board trace). Reruns archive the previous run under `trace/history/`.

## Run

Node 24+, `pnpm install`, and the shared `../.env.local` (symlinked as `.env.local`).

```bash
cd packages/agents/groomer
pnpm groom /absolute/.work/<id>-<slug> /absolute/repository /absolute/REQUIRED.md
```

The working folder must already hold the ticket's `ticket.md` (the launcher's ticket step writes it). The eve entry point loads the required guidelines from Notion when no snapshot is given:

```bash
pnpm exec eve invoke "Groom the ticket in /absolute/.work/<id>-<slug> for /absolute/repository"
```

## Calling skill

`/aspira-groomer <ticket>` uses `skill/aspira-groomer/`. `--local` runs each round in the calling Claude Code session through `pnpm run groom:local --repo <repo> [--ticket ID] [--guidelines FILE] [--verify] [--finish]` (`agent/lib/local.ts`): the board stage, the knowledge stage, then per round a `round` task, the chat `answers`, a `summary` task on a confirm, and the `board` stage that renders Grooming Decisions for the session to write, followed by `--verify`. It makes no model calls and needs no gateway key.

Symlink the skill directory into your tool's skills directory (for Claude Code, `~/.claude/skills/aspira-groomer`); the launcher resolves symlinked package paths.
