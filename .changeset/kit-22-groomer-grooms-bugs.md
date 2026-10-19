---
'@aspiralabs/agent-common': patch
'@aspiralabs/groomer': patch
---

The groomer grooms Bug cards as it grooms Features (KIT-22). Until the Diagnoser (KIT-9) exists, a Bug goes through the same path: `/aspira-groomer` and a `/aspira-build-feature` run on a Bug at Idea no longer refuse with "grooms Feature cards only". A Chore is still refused, and a card with no Type is still refused naming the Types it takes.
