# @aspiralabs/build-feature

`/aspira-build-feature <ID> --local` takes a Feature Board ticket from wherever it is on the board to a reviewed, merge-ready pull request. It runs each AI-DLC step's own `/aspira-*` skill in its own subagent, one at a time, reads each step's result, and picks the next step from the card's Status. The merge stays human.

It is the one `/aspira-*` skill that orchestrates other skills instead of launching an agent: the package holds a skill and its driver, and no eve agent.

The process and its rules live in Notion, not here: AI-DLC › From Idea to Release (https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea) and Engineering Central › Agent Instructions (https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3).
