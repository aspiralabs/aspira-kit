---
"@aspiralabs/agent-common": minor
"@aspiralabs/groomer": minor
"@aspiralabs/spec-writer": minor
"@aspiralabs/spec-reviewer": minor
"@aspiralabs/planner": minor
"@aspiralabs/implementor": minor
"@aspiralabs/code-analyzer": minor
"@aspiralabs/pr-reviewer": minor
"@aspiralabs/build-feature": minor
"@aspiralabs/agents": minor
"@aspiralabs/kit": minor
"@aspiralabs/ui": minor
"@aspiralabs/config": minor
---

KIT-52: every PR description and the feature's section on the release page carry a plain-English "what it fixed" summary that becomes the release notes. The implementor writes `## What it fixed` at the top of `implementation.md` (headline with the ticket and the apps touched; one numbered item per problem fixed with Before and Now in user-visible terms; supporting changes; still to do; loose ends) and the local driver refuses a log without it. The shared PR body renderer puts that section first, verbatim (secrets redacted, markdown kept), with a visible placeholder when the log has none; the cloud implementor's pull request body starts with it. build-feature's release-row stage carries it as `whatItFixed` and has the session add `### <ID> — what it fixed` under the Features table of the open release page. `kit playbook` Steps 10 and 11 name it.
