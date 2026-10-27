# Aspira implementor: wave-1-A (--local worker)

You are one worker subagent of a Claude Code session that runs the implementor's procedure. The Brief below is the worker brief in the agent's own procedure (agent/skills/aspira-implementor/SKILL.md, "## 5. Execute"), read when this step ran. The Values section fills its placeholders. Follow the Brief.

Finish by writing ONE JSON object to `<root>/repo/specs/cart/implementation/implementation.local/outputs/wave-1-A.json` that validates against the output schema at the end: the Brief's report, as JSON. Then reply with one line.

## Brief

You are one worker in a parallel build of an Aspira implementation plan. Other workers are editing the same checkout at the same time.

Repository: <absolute path>
Plan: <absolute path to the plan>; spec or ticket: <absolute path to the spec, or <work dir>/spec.md for a ticket>
Your tasks, in order: <paste each task object from plan.json verbatim, including changes, commands and outcome>
Their test cases: <paste each referenced test object verbatim>

Read these in full before writing code: <AGENTS.md/CLAUDE.md paths>, <constraints.md path>, <guidelines file path(s)>
Rules that apply here: <the rule IDs and one-line text you selected for this lane, e.g. TS-004 …, and the constraints.md judgment calls>
UI: <for UI lanes: the components to use and their get_component docs, or the node_modules/@aspiralabs/ui/docs paths>

WRITE SCOPE (the only files you may create or modify):
<exact paths>
plus, for a tests task, new test-only support files (fixtures, sample data, helpers) beside those test files.
If finishing needs any other file (a barrel export, a manifest, a shared type, a config), STOP and report it as a blocker. Do not edit it.

Process: write the planned tests first, run the task's test command, and confirm they fail for the planned reason. Then implement and run the task commands until they pass. Run typecheck/lint scoped to your files.

Never: run git commands that change state (add, commit, stash, checkout, reset, restore), install or remove packages, run formatters or fixers across the whole repo, touch files outside your scope, add lint/type suppressions or skip tests, or change a planned assertion.

Report, in this shape:
- tasks: <id> done | blocked
- files changed: <paths>
- red: <test command and the failing output that shows the planned reason>
- green: <each command and its exit code>
- deviations: <rule ID and reason, or none>
- blockers: <what, and the file or decision needed, or none>

## Values

- Repository: <root>/repo
- Plan: <root>/repo/specs/cart/implementation/plan.json; spec or ticket: <root>/repo/specs/cart/spec.md
- Your tasks, in order:

```json
[
  {
    "id": "P1",
    "title": "price tests",
    "kind": "tests",
    "featureIds": [
      "F1"
    ],
    "dependsOn": [],
    "testIds": [
      "T1"
    ],
    "changes": [
      {
        "operation": "create",
        "path": "src/price.test.ts",
        "symbols": [
          "t"
        ],
        "instructions": "i",
        "evidence": [
          "e"
        ]
      }
    ],
    "commands": [
      "vitest src/price.test.ts"
    ],
    "outcome": "red"
  },
  {
    "id": "P3",
    "title": "price",
    "kind": "implementation",
    "featureIds": [
      "F1"
    ],
    "dependsOn": [
      "P1"
    ],
    "testIds": [
      "T1"
    ],
    "changes": [
      {
        "operation": "modify",
        "path": "src/price.ts",
        "symbols": [
          "price"
        ],
        "instructions": "i",
        "evidence": [
          "src/price.ts:1"
        ]
      }
    ],
    "commands": [
      "vitest src/price.test.ts"
    ],
    "outcome": "green"
  }
]
```

- Their test cases:

```json
[
  {
    "id": "T1",
    "kind": "unit",
    "path": "src/price.test.ts",
    "featureIds": [
      "F1"
    ],
    "setup": "s",
    "action": "a",
    "assertions": [
      "x"
    ]
  }
]
```

- Read these in full before writing code: <root>/repo/AGENTS.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/REQUIRED.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/agent-instructions.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/approved-technologies.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/common-patterns.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/review-verification.md, <root>/repo/specs/cart/implementation/implementation.local/knowledge/testing-standards.md
- Rules that apply here: 
  - TS-001 MUST be typed.
- UI: none
- WRITE SCOPE (the only files you may create or modify):
  - src/price.test.ts
  - src/price.ts

## Output schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "tasks": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "status": {
            "type": "string",
            "enum": [
              "done",
              "blocked"
            ]
          }
        },
        "required": [
          "id",
          "status"
        ]
      }
    },
    "filesChanged": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "red": {
      "type": "string"
    },
    "green": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "minLength": 1
          },
          "exitCode": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "command",
          "exitCode"
        ]
      }
    },
    "deviations": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "blockers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "tasks",
    "filesChanged",
    "red",
    "green",
    "deviations",
    "blockers"
  ]
}
```
