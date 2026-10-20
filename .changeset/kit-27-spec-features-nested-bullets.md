---
'@aspiralabs/agent-common': patch
'@aspiralabs/spec-writer': patch
'@aspiralabs/spec-reviewer': patch
---

A feature in a spec's Features list may carry its detail in indented bullets beneath it (KIT-27). The business-spec check counted every bullet, indented ones included, as a feature and failed a spec whose features had sub-bullets with "Every feature must have an unchecked, unique F-number", naming no line. It now holds only top-level bullets to the `- [ ] F<n>:` form and names the lines that are not. The spec writer's draft prompt and the review pipeline's contract say so.
