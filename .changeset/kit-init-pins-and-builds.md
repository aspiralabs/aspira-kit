---
'@aspiralabs/kit': patch
---

`kit init` installs every `@aspiralabs` package at the kit's own version instead of a bare name, so the four packages stay in lockstep and pnpm 12's minimum-release-age policy cannot resolve a just-released version down to an older one (a fresh 0.5.0 install pulled `@aspiralabs/ui` 0.4.1). When pnpm 12 refuses a dependency's build script, `kit init` approves exactly the packages pnpm named in the project's `pnpm.onlyBuiltDependencies` and reruns the install, instead of failing.
