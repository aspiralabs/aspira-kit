---
'@aspiralabs/kit': patch
---

Agents: the shared `agent-common` package gains the two modules the ticket-aware skills build on. `lib/board` is the one client for a product's Feature Board in Notion: it resolves a ticket by ID or URL, moves it between statuses (refusing a move from the wrong status), sets Dev and PR, and pushes or pulls the ticket's child pages such as Spec and Plan. `lib/notion-markdown` converts Notion markdown to plain markdown and plain markdown to Notion blocks, both ways deterministic, so a pulled spec and a pushed plan keep every heading, list item, table cell and code line. No skill uses them yet; that wiring is the next change.
