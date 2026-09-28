# Spec review v2 evaluation protocol

> Historical design, superseded by `specs/agents-spec-review.md`. The debate/audit implementation has been removed.

Keep application-specific specs, pinned source revisions, historical issue lists and run results outside this agent repository. The reviewer must not receive the expected issue list as input.

For each benchmark, define expected issues before reviewing and map actual findings to those issues by ID. Record retained issues, omissions, new findings, elapsed time and cost in the external evaluation workspace. V2's target is at least 87% of expected issues, no more than six minutes wall clock, and no greater cost than the original two-seat review of the same inputs.

Compare agents using identical spec, repository, guidelines and MCP evidence. Repeat runs and include held-out specs from multiple projects before claiming general reliability. Historical product-specific results are not distributed with this repository.
