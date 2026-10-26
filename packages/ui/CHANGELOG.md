# @aspiralabs/ui

## 0.19.0

## 0.18.0

## 0.17.1

## 0.17.0

## 0.16.0

### Minor Changes

- 2b6e14f: Aspira Labs now publishes three packages: `@aspiralabs/ui`, `@aspiralabs/config` and `@aspiralabs/ai`. `@aspiralabs/ai` holds everything AI-related in one package: the eleven `/aspira-*` skills, the agents behind them (groomer, spec-writer, planner, implementor, code-analyzer, pr-reviewer, build-feature, visual-verify) and the `kit` command. It replaces the former `@aspiralabs/kit`, `@aspiralabs/agents` and the per-agent packages, which stop receiving releases (their history stays in this changelog).

  Install it globally per engineer (`pnpm add -g @aspiralabs/ai`) and as a devDependency of each project; inside a project the project's copy runs, and `kit init` copies the skills pinned to that version. `kit` and the session-start hook now check once a day whether a newer version exists and print the upgrade commands, staying silent when offline. The engineer setup guide and the 0.15 to 0.16 migration guide in Notion describe the steps.

## 0.15.0

## 0.14.0

### Minor Changes

- bf32c29: InputOTP takes a `stretch` prop: the code row fills its container's width and the slots share it, instead of the fixed `w-12` slots (328px for six). Works with `length`, with composed children, and inside `Form`. Default unchanged.

## 0.13.0

## 0.12.0

### Minor Changes

- 87ad569: KIT-54: research can happen at any stage. One research rule, verbatim in every in-session task prompt and every cloud agent's instructions: anything missing or vague is looked up first, in the repository's code, in Notion (any page or database the rules, the ticket, the idea or the spec point to) and in public documentation; what a phase was given is a head start, not a wall; "unknown" or a gap only once that research is exhausted, naming where it looked. The cloud research, reconciliation, draft and planning phases now read through tools (they were tool-less structured calls), with `notion_read` and `notion_search` on the integration token for any Notion page or database. The planner no longer fails on research or plan gaps: they are notes for the approver, listed as `openGaps`. The guidelines snapshot's INDEX.md lists the databases the rules link (Approved Technologies, ADRs) and how to read their rows.

## 0.11.1

## 0.11.0

### Minor Changes

- da30ab0: KIT-52: every PR description and the feature's section on the release page carry a plain-English "what it fixed" summary that becomes the release notes. The implementor writes `## What it fixed` at the top of `implementation.md` (headline with the ticket and the apps touched; one numbered item per problem fixed with Before and Now in user-visible terms; supporting changes; still to do; loose ends) and the local driver refuses a log without it. The shared PR body renderer puts that section first, verbatim (secrets redacted, markdown kept), with a visible placeholder when the log has none; the cloud implementor's pull request body starts with it. build-feature's release-row stage carries it as `whatItFixed` and has the session add `### <ID> — what it fixed` under the Features table of the open release page. `kit playbook` Steps 10 and 11 name it.

## 0.10.0

### Minor Changes

- 23c44cf: KIT-51: running in the session is the default mode of every `/aspira-*` skill, and `--cloud` is the flag for the separate agent. `/aspira-<skill> <ID>` now does what `<ID> --local` did; `--local` is still accepted and means the default. `/aspira-build-feature <ID>` runs every step in the session and `--cloud` runs every step's cloud agent (`--autonomous` is refused with `--cloud`). The Playbook rows, `kit playbook`, the progress notes' Next action and the build-feature resume command print the commands without `--local`; a cloud run's commands carry `--cloud`. The launchers accept `--cloud` and `--local` and refuse the one that contradicts the subcommand.

## 0.9.2

## 0.9.1

## 0.9.0

## 0.8.15

## 0.8.14

## 0.8.13

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

## 0.8.8

## 0.8.7

## 0.8.6

## 0.8.5

## 0.8.4

## 0.8.3

## 0.8.2

## 0.8.1

## 0.8.0

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.5

## 0.5.4

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.2

## 0.4.1

## 0.4.0

### Minor Changes

- ab42330: Add `FileInput`, a native file picker that forwards every input prop and `ref` and adds `onFilesChange(files)`. `Input` now forwards a caller's `ref` (merged with the mask's) and renders `type="hidden"` as a bare hidden input. Spec: specs/ui-input-gaps.md

## 0.3.0

### Minor Changes

- 9e1b4e5: Add `useFormAction` and `useToolbarUrlState` (the state hook for `StandardToolbar`), ported from PET_WASTE_CRM. Hooks now live in `src/hooks/` and are also available from the `@aspiralabs/ui/hooks` subpath; root imports are unchanged. Adds docs under a new Hooks group.

## 0.2.1

### Patch Changes

- 068f42c: `InputDate` imports `dayjs/plugin/customParseFormat.js` with its extension. dayjs has no `exports` map, so the bare subpath only resolved under a bundler; strict ESM resolution (Node, vitest with the package externalized) failed with `ERR_MODULE_NOT_FOUND`.

## 0.2.0

### Minor Changes

- 239e049: Port the improvements the products made to their local copies of the core components (spec: `specs/product-drift-port.md`).

  Fixes: `Input` no longer loops when given an inline `mask={{...}}` in controlled mode (mask options are keyed by contents; sync writes are not echoed back, and the guard is one-shot so clearing a field is still reported); `InputDate` ignores imask's transient re-emits in controlled mode; `Form` no longer crashes on a `Textarea` without a `name`; floating panels open above drawers; `InputSelect` no longer trips Radix's "uncontrolled to controlled" warning when an uncontrolled select gets its first selection.

  Additive: `Form` renders a `FormProvider` (`useFormContext()` works inside it); `Drawer` `size` measures the card and is clamped to the viewport; `DataTable` gains `loading` / `skeletonRows`; `DataInfiniteTable`'s loading state hugs its skeleton rows; `Input type="password"` gets a show/hide toggle; `Section` gains `divider`; `Page.Header` config gains `description`; `InputSelect` warns in development when two options stringify to the same value (Radix compares values as strings, so one of them could never be selected).

  New: `InputAddress`, a Mapbox-autocompleted street field that fills sibling city/state/zip/lat/lng form fields. The token is a prop.

### Patch Changes

- 239e049: `@aspiralabs/ui`: the 43 JSX ternaries that came over from SAAS_BOILER are rewritten (lookup maps, early-return helpers, precomputed props) and the package-level lint exemption is removed, so the org's no-ternary rule now holds inside the ui package. No rendered output changes. `@aspiralabs/config`: first two agent guides, `table-pagination` and `choosing-a-selector`.

## 0.1.0

### Minor Changes

- d898b86: Initial release: the ui library with tokens, docs, and MCP server; shared eslint, tsconfig, prettier, and agent config; the kit CLI.
