---
"@aspiralabs/ai": patch
---

In-session runs push their pages (Plan, Spec, Implementation, PR Review…) through the Notion API with the markdown converter when NOTION_TOKEN is set, instead of having the session retype each page through the Notion MCP. A failed API push falls back to the session push action.
