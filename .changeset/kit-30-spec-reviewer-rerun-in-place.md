---
'@aspiralabs/spec-reviewer': patch
---

The spec reviewer reruns on the answered `spec.reviewed/spec.reviewed.md` (KIT-30). After a needs-author or incomplete review the Playbook says to answer there and rerun, but the output-directory guard refused the spec the reviewer had written itself ("Output directory must not contain the source spec or guidelines"). The reviewer now accepts its own previous `spec.reviewed.md` as the spec, strips the previous review's header above the candidate, keeps the input as `spec.original.md` and reads the ticked decisions from the previous `trace/decisions.md`. The guidelines, or any other spec, inside the report directory are still refused.
