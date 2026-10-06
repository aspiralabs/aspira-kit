---
'@aspiralabs/kit': patch
---

The board module accepts the Feature Board's database page URL, the one a person copies from Notion and `kit init --board` stores, by looking up the database's data source on first use. Before, only the data source id worked, so `kit next` and every ticket-aware skill answered "the board did not answer" on a freshly initialised project.
