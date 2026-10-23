---
'@aspiralabs/build-feature': minor
'@aspiralabs/kit': minor
---

/aspira-build-feature now fixes every review finding at medium or above, not just critical and high. It runs the project gate again on each fix before the next review, and stops after four reviews. A fix that would contradict a ticket decision is not made; the run asks the human and hands the answer to the next fix. Once the last review leaves nothing medium or above, the run merges the PR itself (a new `merge` stage: wait for the PR checks, `gh pr merge --merge`, read back MERGED) and moves the card to Ready: Implementation on its run-start approval (BOARD-004 revised). The Playbook's Step 9 and Step 10 text says the same. When aspira.json names `releases`, the run updates the feature's entry on the open release page between the merge and the move: the row's state, the checklist, the open lows as follow-ups, and the summary checked against the merged diff.
