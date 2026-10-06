---
'@aspiralabs/kit': patch
---

`kit next` finds the agents' TypeScript loader the way Node would, from an installed agent's real location, so it works in a pnpm project (the loader sits two levels up from a scoped package, not beside agent-common). When the board cannot be resolved it now prints the resolver's actual error instead of a guess.
