# {{project}}

<!-- aspiralabs:begin (managed by @aspiralabs/kit; do not edit inside this block) -->
This project is on the Aspira Labs kit. The org-level agent guide is `node_modules/@aspiralabs/config/agent/AGENTS.md`: read it first. It points at the engineering rules in Notion (Engineering Central › Agent Instructions), the always-on constraints in `node_modules/@aspiralabs/config/agent/constraints.md` (injected at session start), and the process every app follows.

- The flow: when asked what the next step is, about the process, or which command to run for a ticket, answer from Engineering Central › AI-DLC › From Idea to Release, Playbook section (https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea). The ticket's Status on the Feature Board picks the step. Do not answer from memory.
- Feature work lives in `specs/<id>-<slug>/` (`idea.md`, `spec.md`, `spec.reviewed/`, `plan.review/`), one folder per ticket, the same in every project. Agent trace folders (`trace/`, `guidelines/`, `knowledge/`, `*.local/`) are not committed. No other location.
- Component docs: the `aspiralabs-ui` MCP server. Call `get_component` before writing or editing component markup.
- Guides, pitfalls, decisions: `node_modules/@aspiralabs/config/agent/`.
- Lint, types, and formatting come from `@aspiralabs/config`. Run `pnpm check` before opening a PR.
- No spec, no code. A spec defines business acceptance criteria. An implementation plan defines technical tasks and unit/integration tests; write tests first.
<!-- aspiralabs:end -->

## About this project

(product-specific context goes here and is never touched by the kit)

## Gotchas

(project facts that contradict a reasonable assumption, one line each: a config list nothing renders, an endpoint a shipped client consumes that looks unused, a helper whose name says one thing and whose shape says another. Reviewers read this section before writing a finding, so a fact here is a finding they will not raise.)
