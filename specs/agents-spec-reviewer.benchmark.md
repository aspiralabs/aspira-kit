# Spec review evaluation protocol

The reviewer accepts any local repository and spec. This package contains no real application's benchmark fixture, expected findings or saved review results.

## Inputs

Keep the spec, a pinned repository revision, the required-guidelines snapshot, expected issues and outputs in the reviewed project or a separate evaluation workspace. Record the model configuration and MCP sources used. Build the expected issue list before running the reviewer; never pass it to the reviewer as context.

## Procedure

1. Run the official reviewer with the spec, repository, guidelines and an output directory outside this package.
2. Have a human map each expected issue to exact finding and resolution quotes in that run. Use stable issue IDs of your choosing and optional additional evidence for issues spanning findings.
3. Supply an external evaluation manifest containing `expectedIssueIds` and `mappings`. See the package README for its format.
4. Run `pnpm score /absolute/run-directory /absolute/evaluation.json` from the spec-reviewer package.
5. Record retained and missing issues, new findings, total and per-phase duration, costs, incomplete phases and unresolved author decisions in the external evaluation workspace.

The scorer checks evidence existence, retained dispositions, and completeness. Duration is recorded, not a pass/fail gate. It does not establish semantic correctness. A human must assess whether a proposed edit actually addresses each issue and whether additional findings are valid.

## Comparing agents

Use the same spec, repository revision, guidelines and available MCP evidence for each agent. Measure preparation separately as well as end-to-end time. Compare repeated runs across several independent projects, including held-out specs. Synthetic test success is not evidence of live recall, and a tuned fixture does not establish general reliability. No cross-project recall or timing result is claimed by this protocol.
