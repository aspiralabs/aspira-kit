---
"@aspiralabs/ai": patch
---

The in-session PR reviewer reviews a pull request whose diff GitHub refuses through the API (406, too large): the diff is rebuilt from the PR's paged file list instead of ending the review incomplete. A PR at GitHub's 3,000-file listing limit is refused with a message to split it, never reviewed in part.

build-feature reads the files a review finding cites from a `Location:` line written without a list bullet, the way the PR reviewer writes it, so a fix of that finding is no longer refused as editing files outside the findings.
