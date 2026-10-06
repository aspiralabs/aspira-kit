---
'@aspiralabs/kit': patch
---

`kit init` approves pnpm build scripts the way pnpm 12.4 expects: `allowBuilds: <name>: true` in `pnpm-workspace.yaml`, replacing the placeholder pnpm writes there, and it retries each install until no new build script is reported (at most five times).
