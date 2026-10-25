---
'@aspiralabs/ai': patch
---

Five fixes from the ScoopLine SCOOP-7 and SCOOP-8 runs.

- Planner: the final-verification rule names what to change. A task after the verification gets "The last task must be the verification task: P19 (handoff) comes after P18. Move it before P18 (taskOrder) and drop any dependency on P18"; a missing dependency names the implementation tasks to add. The planning prompt says handoffs come before the verification. Both repair passes had kept a trailing handoff, since the old message gave them nothing to change.
- Implementor: a `local` call after a ready export, with HEAD where the build left it, answers from that export. It used to start a new run whose gate read the build's own commits as plan drift and rewrote the trace as refused.
- build-feature: the skill launches each step subagent with a background wait on its report file and steps the driver as soon as the report exists, never holding the run for the Agent tool's usage numbers (the driver already takes a report without them). Runs sat idle for hours waiting on a hand-back or on telemetry.
- Page pushes through the Notion API put nested children inside the block's type object (`bulleted_list_item.children`, `table.children`), send one level of children per request, and always send a table with its rows; a block holding a table sends its children in a later request. Nested lists three deep and tables, at the top or inside a list, no longer fail with Notion's 400.
- Spec writer: a write-mode retry (from In Progress: Spec) keeps every answer the author ticked in the previous run's decisions file. The draft prompt states them as settled, and any the draft leaves out is written into its `## Decisions` before the review, which then treats it as settled. A retry had kept 1 of 3.
