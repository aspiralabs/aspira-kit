---
'@aspiralabs/ai': patch
---

The knowledge walk follows inline page links again. Notion's markdown endpoint (Notion-Version 2026-03-11) now renders them as `<mention-page url="…">Title</mention-page>`, and the walk matched only the self-closing `<mention-page url="…"/>`, so it loaded the index alone and every step that needs Review Verification stopped with "Required knowledge page not loaded". Both forms are read, and a paired mention keeps its title.
