---
'@aspiralabs/build-feature': patch
---

The run-start approval is the invocation itself (KIT-20). The driver records who ran `/aspira-build-feature` (the git user of the checkout, else the shell user), when, and the command, at run start; no `approval` stage asks the session to call notion-get-self and write an approval file, which the Claude Code auto-mode classifier refuses as self-approval. A run pending on the old stage still has its answer read once.
