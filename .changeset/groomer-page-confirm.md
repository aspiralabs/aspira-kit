---
"@aspiralabs/ai": patch
---

The in-session groomer takes a Confirm ticked on Grooming Decisions as the Confirm when the round leaves nothing to ask, instead of asking it again in chat. A build-feature run resumed after the human ticked Confirm on the page no longer stops a second time for the same Confirm.

The run marker ("Run: … in progress") on a pulled Grooming Decisions page is never carried into the Notes of the next rendering, so a verbatim page replace no longer puts it back after the unmark action removed it.
