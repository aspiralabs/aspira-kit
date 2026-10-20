---
'@aspiralabs/planner': patch
---

Planner (KIT-35): the UI catalog check passes on a successful `list_components` alone; it no longer demands `get_component` reads, which a project whose UI package has no documented components yet could never make. Under `--local`, the research and planning subagents may read, read-only and with a citation, a Notion page the spec or the ticket names (a product doc the work mirrors, a decision page); before, the prompt forbade every Notion page beyond the guideline topics, so a spec that mirrors a product page always ended with a research gap.
