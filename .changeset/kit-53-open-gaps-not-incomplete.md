---
"@aspiralabs/spec-reviewer": patch
"@aspiralabs/spec-writer": patch
---

KIT-53: an evidence gap nobody closed no longer ends a spec review `incomplete`. The pipeline carries them as `openGaps`; `trace/findings.md` and `trace/checks.md` list them under "Evidence gaps left open" for the human approving the spec, who can answer one in the spec with the source named (KIT-31). The specialists are told the research's gaps in their lens are theirs to close with their tools, and the reconciliation prompt says what each gap resolution status means. SIFT-8's spec step had ended incomplete after 27 minutes on eight unverified facts.
