---
'@aspiralabs/agent-common': patch
'@aspiralabs/groomer': patch
---

A Confirm confirms every decided question (KIT-25). The Idea summary lists the decisions taken as recommended (`--take-recommended`, `--autonomous`) beside the author's, and the summary validator accepts and requires them; before, the summary prompt named only the author's decisions and the validator refused a summary that listed a taken one, so a confirmed grooming either lost its taken decisions from the Idea the spec writer reads or could not finish.
