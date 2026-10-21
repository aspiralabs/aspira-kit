---
"@aspiralabs/agent-common": minor
"@aspiralabs/groomer": minor
"@aspiralabs/spec-writer": minor
"@aspiralabs/spec-reviewer": minor
"@aspiralabs/planner": minor
"@aspiralabs/implementor": minor
"@aspiralabs/code-analyzer": minor
"@aspiralabs/pr-reviewer": minor
"@aspiralabs/build-feature": minor
"@aspiralabs/agents": minor
"@aspiralabs/kit": minor
"@aspiralabs/ui": minor
"@aspiralabs/config": minor
---

KIT-54: research can happen at any stage. One research rule, verbatim in every in-session task prompt and every cloud agent's instructions: anything missing or vague is looked up first, in the repository's code, in Notion (any page or database the rules, the ticket, the idea or the spec point to) and in public documentation; what a phase was given is a head start, not a wall; "unknown" or a gap only once that research is exhausted, naming where it looked. The cloud research, reconciliation, draft and planning phases now read through tools (they were tool-less structured calls), with `notion_read` and `notion_search` on the integration token for any Notion page or database. The planner no longer fails on research or plan gaps: they are notes for the approver, listed as `openGaps`. The guidelines snapshot's INDEX.md lists the databases the rules link (Approved Technologies, ADRs) and how to read their rows.
