# implementor: the final verification writes down what the build changed and learned

## Intent

The implementor's last task (`P<n>` full verification, `## Run to completion` in its procedure) proves the build is done. Three things it never wrote down in the NOM-4 build (2026-10-04): which dependencies the build added, what the mid-build lane notes said that was no longer true, and which bugs it fixed that will happen again. The reviewer, the release page and the retro had to find each of those by hand. The final verification now produces all three, and cannot report done without them.

## Acceptance criteria

### Features

- [ ] F1: **Dependencies added are listed.** The final verification diffs every package manifest in the repository (`package.json`, `apps/*/package.json`, `services/*/package.json`, and any other manifest the build touched, including lockfile-only changes) between the branch base and HEAD, and writes a `## Dependencies added` section in `implementation.md`: name, version, which app, dev or runtime, and two flags: **native** (a React Native or Expo module with native code, decided by the package's `ios/` or `android/` directory or an `expo-module.config.json` or `react-native.config.js` in the installed package) and **approval** (listed on the Approved Technologies page in the loaded knowledge as Adopt or Trial, or not listed). A native addition says in one sentence that the mobile app needs a store build. An addition that is not listed says that a human must approve it (Agent Instructions, Approved Technologies). A build with no additions writes "None".
- [ ] F2: **Mid-build notes are rewritten from the code or deleted.** Any file the build wrote for lanes to hand off contracts (`handoff-notes.md`, or any file the plan or the orchestrator names as inter-lane notes) is, at final verification, either regenerated from the code as it is at HEAD or deleted. Regenerated means: every identifier, path, option name and signature the notes mention is checked against HEAD (a search per identifier); one that does not exist is corrected to the current name or the sentence is removed. The notes carry a header saying they were rewritten at verification with the commit SHA. Notes are never committed as documentation of the result; if they are kept, they stay in the working folder.
- [ ] F3: **Lessons are proposed, or their absence is justified.** `implementation.md` has a `## Proposed Slop Repo entries` section that the final verification must fill. For every bug found and fixed during the build (the `## Bugs found and fixed` section, red-to-green surprises, a reviewer-style finding the orchestrator corrected) it writes one entry in the Slop Repo's shape: **Rule** (one imperative sentence), **Area** (one of the Slop Repo areas), **What went wrong** (two sentences with the file or symbol), **Source** (`implementor`, the repository and ticket). The test for an entry is "could this happen again in another feature or repository". If no bug qualifies, the section says "None: <one sentence per bug saying why it would not recur>". A build that found no bugs says "None: no bugs were found and fixed". The report cannot be `done` with the section empty or missing.
- [ ] F4: **The report cannot say done without them.** The `verification` stage output schema requires `dependenciesAdded` (array, may be empty), `notesRewritten` (array of `{ file, action: 'rewritten' | 'deleted' }`, may be empty) and `slopEntries` (array; when empty, `slopJustification` non-empty). The driver rejects an output that lacks them the same way it rejects any schema failure (one resend with the error, then `--finish` exports as incomplete). The default (separate process) path applies the same schema.
- [ ] F5: **The procedure says it once.** `agent/instructions.md` gains the three requirements in its final verification section, in the words the skill-rules test pins. `SKILL.md` restates none of them.

### Tests

- [ ] unit: the manifest diff on a fixture repository with a root manifest, two app manifests and a lockfile-only change: the added set is exact; a native module is flagged by each of the three markers; a package absent from the Approved Technologies fixture is flagged as not listed.
- [ ] unit: notes rewriting on a fixture: an identifier that no longer exists is corrected when a renamed symbol is found, and removed when nothing is found; the header carries the SHA; a deleted notes file is reported as deleted.
- [ ] unit: the verification schema rejects an output missing any of the three fields, and an empty `slopEntries` without `slopJustification`.
- [ ] unit: the skill-rules test pins the three new sentences in `agent/instructions.md`.
- [ ] integration: the implementor `--local` driver on a fixture plan: the final verification task's prompt names the three requirements, and the exported `implementation.md` has the three sections.

## Implementation and verification plan

- The manifest diff and the native and approval flags as a pure module in `packages/agents/implementor/agent/lib/dependencies.ts`, fed by `git diff <base>...HEAD -- '**/package.json'` and the installed `node_modules` of each app.
- The notes check as `agent/lib/notes.ts`: identifiers are backticked tokens in the notes; each is searched in the repository with `git grep -F`.
- The Slop Repo areas come from the knowledge folder's Agent Instructions page (the topic table) so the list is never hard-coded.
- Extend the verification schema and the prompt builder; run the package's `test`, `typecheck` and `lint`.

## Out of scope

Writing the Slop Repo entries into Notion. A human ratifies them (Agent Instructions, Writing back lessons); the ticket-flow spec's push of `implementation.md` carries them to the ticket.
