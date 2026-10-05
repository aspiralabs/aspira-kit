// Rules that earned their place in the skill and the cloud instructions, each
// pinned by the sentence that carries it. A rewrite that drops the sentence
// reads as a harmless tidy-up; this test makes it a failure with the reason
// attached. Rewording is fine: update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'agent/skills/aspira-implementor/SKILL.md'
const instructions = 'agent/instructions.md'

const rules = [
  { reason: 'a red test proves the instrument only when it fails for the predicted reason, not an import error', file: skill, phrase: 'they must fail for the reason the plan predicts' },
  { reason: 'green by suppression is not green', file: skill, phrase: 'Never get to green by adding `eslint-disable`' },
  { reason: 'config edits hide failures from every later run', file: skill, phrase: 'never edit linter or test config to make a failure go away' },
  { reason: 'a wrong planned test is a plan defect, not something to quietly fix', file: skill, phrase: 'If a test in the plan is wrong, that is a blocker to report' },
  { reason: 'the human is not watching; blocking on confirmation stalls the whole build', file: skill, phrase: 'Do not stop to ask for confirmation, approval of the plan or permission to continue' },
  { reason: 'assumptions are only safe when the human can see and overturn them', file: skill, phrase: 'Report every assumption in the summary so the human can overturn it' },
  { reason: 'irreversible or high-risk choices are the one thing not to guess', file: skill, phrase: 'destructive data migrations, deleting user data, auth/permission models, payments, security boundaries' },
  { reason: 'a stale plan rewrites files that moved; drift is a blocker, not something to re-plan around', file: skill, phrase: "Compare the plan's `repoCommit`" },
  { reason: 'a build on the default branch mixes unreviewed work into it; the session must branch first', file: skill, phrase: 'never on the default branch, and settle it before writing any file' },
  { reason: 'a rerun must continue on the existing feature branch, not fork a second one', file: skill, phrase: 'switch to the dedicated branch if it already exists' },
  { reason: 'building on a branch for different work tangles two features in one history', file: skill, phrase: 'Do not build on it or branch from it' },
  { reason: "other people's uncommitted work is never staged, stashed or reverted", file: skill, phrase: 'Leave uncommitted changes that are not yours alone' },
  { reason: 'skimming the rules is how MUST rules get missed', file: skill, phrase: 'Do not skim: use full reads, never `head`' },
  { reason: 'unlisted dependencies are an approved-technologies decision, not a build detail', file: skill, phrase: 'A dependency the plan did not name is a blocker, not a judgment call' },
  { reason: 'a project instruction that contradicts a Notion rule is a human decision', file: skill, phrase: 'If a project instruction conflicts with a Notion rule, stop and put the conflict to the human' },
  { reason: 'workers get the rules in their brief; N workers re-reading Notion is cost and drift', file: skill, phrase: 'Workers do not re-fetch Notion' },
  { reason: 'hot files conflict even when the plan forgot them; two lanes on one barrel file is a broken build', file: skill, phrase: '**Hot files** always conflict, even when the plan forgot to list them' },
  { reason: 'a worker sees none of the orchestrator context', file: skill, phrase: 'Its brief must stand alone' },
  { reason: 'a worker that needs a file outside its scope stops; editing it races the other lanes', file: skill, phrase: 'STOP and report it as a blocker. Do not edit it.' },
  { reason: 'worker reports are claims; the orchestrator checks the tree', file: skill, phrase: 'Do not trust the reports' },
  { reason: 'a stray edit outside every write scope is never committed by accident', file: skill, phrase: "every changed path must be in some lane's write scope" },
  { reason: 'silent workarounds are the failure mode the whole pipeline is built to prevent', file: skill, phrase: 'Working around a blocker in silence is the failure mode' },
  { reason: 'a reviewed plan is a contract; changing it silently voids the review', file: skill, phrase: 'Never re-plan silently' },
  { reason: 'a feature is done when its tests pass, not when its code compiles', file: skill, phrase: 'A feature with a failing or missing test is not done' },
  { reason: 'review separation: green tests are not review', file: skill, phrase: 'The builder does not approve its own code' },
  { reason: 'repeated mistakes become Slop Repo entries, not memory', file: skill, phrase: 'add an entry to the AI Agent Slop Repo in Notion' },
  { reason: 'lane copies share the sandbox; a second checkout or publish corrupts the run', file: instructions, phrase: 'Copies do not call `checkout-repo`, `load-knowledge` or `publish-branch`' },
  { reason: 'work that exists only in a dead sandbox was never done', file: instructions, phrase: 'call `publish-branch` once, even for a partial or blocked build' },
]

it('pins each rule with a distinctive phrase', () => {
  const phrases = rules.map((r) => r.phrase)
  expect(new Set(phrases).size).toBe(phrases.length)
  for (const phrase of phrases) expect(phrase.length).toBeGreaterThanOrEqual(20)
})

for (const { reason, file, phrase } of rules) {
  it(`${file} keeps: ${reason}`, () => {
    expect(readFileSync(join(root, file), 'utf8')).toContain(phrase)
  })
}
