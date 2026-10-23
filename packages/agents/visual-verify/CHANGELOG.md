# @aspiralabs/visual-verify

## 0.13.0

### Minor Changes

- e6199cd: KIT-58: visual-verify opens a UI-touching build in a real browser before the gate and reports what it saw. It is a new skill-only package, `/aspira-visual-verify`, that build-feature runs as a phase and that runs on its own (report only) on a ticket In Progress or In Review: Implementation. Projects add an `aspira.json` `dev` entry (`{cwd, command, url, backendDeployed}`) to turn it on.

### Patch Changes

- Updated dependencies [e6199cd]
  - @aspiralabs/agent-common@0.13.0
