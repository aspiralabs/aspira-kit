# @aspiralabs/build-feature

`/aspira-build-feature <ID> [--cloud]` takes a Feature Board ticket from wherever it is on the board to a reviewed and merged pull request. It runs each AI-DLC step's own `/aspira-*` skill in its own subagent, one at a time, reads each step's result, and picks the next step from the card's Status. By default each step skill runs in the session; with `--cloud` each runs with `--cloud`, its cloud-agent mode, and the run waits on it (KIT-51). The run works the ticket in its own git worktree, `.worktrees/<TYPE>-<ID>` on `<feat|fix|chore>/<id>-<slug>`, and never removes it. The review loop fixes every finding at medium or above, running the project gate again on each fix, for at most four reviews; then the run merges the PR itself and moves the card to Ready: Implementation (BOARD-004 as revised 2026-10-23). A fix that would contradict a ticket decision is asked in chat instead.

It is the one `/aspira-*` skill that orchestrates other skills instead of launching an agent: the package holds a skill and its driver, and no eve agent.

The process and its rules live in Notion, not here: AI-DLC › From Idea to Release (https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea) and Engineering Central › Agent Instructions (https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3).
