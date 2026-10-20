---
'@aspiralabs/spec-writer': patch
'@aspiralabs/spec-reviewer': patch
---

Under `--local`, the spec writer's and spec reviewer's research subagents may read Notion (the MCP's read tools) and public documentation (WebFetch, WebSearch) for a fact that lives outside the repository, citing the URL or page with the quoted line (KIT-33). Before, every subagent prompt limited them to repository reads, so a vendor limit, an infrastructure behaviour or a Notion decision was always an evidence gap only the author could close.
