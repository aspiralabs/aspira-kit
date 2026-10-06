# @aspiralabs/agents

One dependency that brings every Aspira Labs agent into a project at the kit's version: `@aspiralabs/spec-writer`, `@aspiralabs/spec-reviewer`, `@aspiralabs/planner`, `@aspiralabs/implementor`, `@aspiralabs/code-analyzer` and `@aspiralabs/pr-reviewer`, plus `@aspiralabs/agent-common`. It ships nothing of its own.

`kit init` adds it as a devDependency and copies each agent's `/aspira-<agent>` skill into the project's `.claude/skills/`, pinned to this version. `kit doctor` prints the installed version and fails when a skill folder is missing or was installed from another version. Updating an agent is a kit release and a dependency bump in the project, then `kit init` again.

The agents themselves are documented in [packages/agents](../README.md).
