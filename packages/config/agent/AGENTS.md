# Aspira Labs agent guide

Every project on the Aspira kit points here from the managed block in its own `AGENTS.md`. This file is the org-level entry point for an AI agent: where the rules are, where the process is, and which file answers which question. The project `AGENTS.md` holds only project facts (stack, commands, layout, Gotchas).

## Read in this order

1. **Engineering Central › Agent Instructions** (Notion): https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3. The rules index. It routes each kind of task to the topic page to read. Fetch it with the Notion MCP at the start of a task. MUST rules are required; a SHOULD you deviate from is stated with its reason in the reply or PR.
2. `constraints.md` in this folder: the always-on rules that no lint rule or type can catch. Injected at session start by the kit's hook.
3. The project's `AGENTS.md`, Gotchas section first.

When a project instruction conflicts with an Engineering Central rule, stop and flag it to a human. Do not pick one silently.

## The flow: what is the next step

The process every app follows is **Engineering Central › AI-DLC › From Idea to Release**: https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea. Its **Playbook** section lists, for every Feature Board status, the step to run and the exact command. When asked what comes next, about the process, or which command to run for a ticket, answer from that page using the ticket's Status. Do not answer from memory.

Related pages:

- **Feature Board**: https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad. Statuses, views and the BOARD rules. Only a human moves a ticket to a Ready column or merges a PR.
- **Releases**: https://app.notion.com/p/3f13e59b22588106ab5dc457a42b0e1c. One page per release; a feature adds itself before its PR merges (REL-002).
- **Review Verification**: https://app.notion.com/p/3e83e59b225881caa641db4f121662da. The checks a reviewer runs before writing a finding. Spec review and PR review both read it.
- **AI-DLC overview**: https://app.notion.com/p/3e83e59b2258817b8658f355337a4917. What the kit gives you and which skill runs which step.

## Where feature work lives

One gitignored working folder per ticket, the same path in every project:

```text
.work/<id>-<slug>/          e.g. .work/nom-4-explore-pagination/
  ticket.md                 pulled from the board: ID, status, links, the Idea
  spec.md                   the ticket's Spec page
  spec.reviewed/            spec-reviewer output; spec.reviewed.md goes back to the ticket as Spec Reviewed
  plan.review/              planner output; plan.reviewed.md goes back as Plan; the implementor adds implementation.md, which goes back as Implementation
  pr-review/                what the PR reviewer writes
  trace/, *.local/          whatever the agents keep between steps
```

`<id>` is the Feature Board ticket ID in lower case. The ticket in Notion is the record: every document a step produces is pushed back to the ticket as a child page. The folder is a cache of the ticket plus the agents' scratch, for the human running the steps and the agent on the branch. Anyone can rebuild it from the ticket with the pull step. Nothing in it is committed, on any branch: `kit init` adds `.work/` to `.gitignore`, and `kit doctor` fails if that line is missing or if a `specs/`, `docs/plans/` or `docs/working-feature/` folder exists. Commit trailers (`Spec: <ticket URL>`) and PR descriptions cite the ticket, not a path.

## The skills

Each step of the flow has a skill, `/aspira-<agent>`, and each skill only launches its agent: spec-writer, spec-reviewer, planner, implementor, code-analyzer, pr-reviewer. The agent's own `agent/instructions.md` is the single source of truth for what the step does. `--local` runs the same pipeline inside the Claude Code session on session usage; without it the agent runs as a separate process billed through the AI Gateway. Every path loads the Engineering Central rules and refuses to run without them.

## What else is in this folder

- `constraints.md`: always-on rules.
- `guides/`: how-to pages for recurring tasks.
- `pitfalls.md`: mistakes agents keep making and the fix for each.
- `decisions.md`: architectural choices already made; do not reopen them.
- `slop-register.md`: a snapshot of the AI Agent Slop Repo.
- `personas/`, `hooks/`, `templates/`: reviewer personas, the session hooks, and the files `kit init` writes into a project.

These files are snapshots that ship with the package. Notion is the live source; when the two disagree, Notion wins and the snapshot needs a kit release.

## Writing back

- A mistake a rule would have prevented, or the same correction twice: an entry in the **AI Agent Slop Repo**, https://app.notion.com/p/bc25fc5cf5464f2593c7a0b663d6f859 (Status: Proposed). A human promotes it into a topic page.
- A gap in a kit agent or skill: the Aspira Kit teamspace's **Kit agent gaps** page, https://app.notion.com/p/3f03e59b2258810487d6f5119e797274.
- A component `@aspiralabs/ui` lacks: the **UI kit gaps** page, https://app.notion.com/p/3f03e59b22588122a97ceae3ff5c9a33.
- A project fact that contradicts a reasonable assumption: the project's `AGENTS.md` Gotchas.
