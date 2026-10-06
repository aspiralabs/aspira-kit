# {{project}}

<!-- aspiralabs:begin (managed by @aspiralabs/kit; do not edit inside this block) -->
This project is on the Aspira Labs kit. The engineering rules and the process live in Notion, not in this repository. Look them up there; do not answer from memory.

- **Rules:** Engineering Central › Agent Instructions, https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. Fetch it with the Notion MCP at the start of every task and follow its table to the topic pages the task needs. Cite rules by ID. If a project instruction below conflicts with a rule there, stop and ask a human.
- **The flow and what comes next:** Engineering Central › AI-DLC › From Idea to Release, https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea. Its Playbook maps the ticket's Status on the Feature Board to the step and the command to run. It also defines where feature work lives in the repo and what a commit cites.
- **Writing back:** a mistake a rule would have prevented goes to the AI Agent Slop Repo, https://app.notion.com/p/bc25fc5cf5464f2593c7a0b663d6f859; a gap in a kit agent or in `@aspiralabs/ui` goes to the Aspira Kit gap pages linked from Agent Instructions.
- **Component docs:** the `aspiralabs-ui` MCP server. Call `get_component` before writing or editing component markup.
- **Agents:** the `/aspira-*` skills in `.claude/skills/` run the agents installed with `@aspiralabs/agents`, pinned to this project's kit version. After a kit bump, run `kit init` again so they match.
- **Lint, types and formatting** come from `@aspiralabs/config`. Run `pnpm check` before opening a PR.

Everything outside this block is project-specific: stack, commands, layout, and Gotchas.
<!-- aspiralabs:end -->

## About this project

(product-specific context goes here and is never touched by the kit)

## Gotchas

(project facts that contradict a reasonable assumption, one line each: a config list nothing renders, an endpoint a shipped client consumes that looks unused, a helper whose name says one thing and whose shape says another. Reviewers read this section before writing a finding, so a fact here is a finding they will not raise.)
