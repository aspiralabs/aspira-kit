// Rules that earned their place in the orchestrator instructions, each pinned
// by the sentence that carries it. A rewrite that drops the sentence reads as
// a harmless tidy-up; this test makes it a failure with the reason attached.
// Rewording is fine: update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const instructions = 'agent/instructions.md'
const skill = 'skill/aspira-pr-reviewer/SKILL.md'

const rules = [
  { reason: 'the orchestrator reports; a seventh opinion from the router is unverified and unrecorded', file: instructions, phrase: 'Never review the diff yourself, never add a finding, never soften one' },
  { reason: 'the verdict is a function of the counts, so it cannot be argued down', file: instructions, phrase: 'The verdict is computed from the counts, not chosen' },
  { reason: 'a review costs seven model calls a round; a silent rerun doubles it', file: instructions, phrase: 'Do not run `pr-debator` twice on the same PR unless the person asks for it' },
  { reason: 'reviewing a guessed branch reviews the wrong code', file: instructions, phrase: 'Never review something you could not load' },
  { reason: 'the branch reviewed must be named when it was defaulted, or the human assumes theirs', file: instructions, phrase: 'say in your reply which branch was reviewed' },
  { reason: 'the review files belong to the seats; the router writing them breaks the verifier chain', file: instructions, phrase: 'Never write to `/workspace/findings.md` or `/workspace/review.md` yourself' },
  { reason: 'the review comment goes only to the PR that was reviewed; posting elsewhere publishes findings to the wrong audience', file: instructions, phrase: 'Post the review only to the PR that was loaded' },
  { reason: 'a review the person asked to keep private must not be posted', file: instructions, phrase: 'Skip it only when the person asked you not to comment' },
  { reason: 'a missing guidelines load is reported, never silently skipped', file: instructions, phrase: 'saying the guidelines were not loaded and why' },
  { reason: 'the agent is the single source of truth; the skill only runs it', file: skill, phrase: 'This skill only runs the official pr-reviewer agent' },
  { reason: 'the orchestrator rules live in the agent and are read at runtime, never restated here', file: skill, phrase: 'read the file named in `orchestrator` in full' },
  { reason: 'local mode is only faithful if each task gets the exact agent prompt', file: skill, phrase: 'do not edit the prompt files' },
  { reason: 'the six seats of a round are independent lenses; run one after another they cost six times the wall clock', file: skill, phrase: 'Launch all six seat tasks **in one message**' },
  { reason: 'a subagent told anything beyond the file names drifts from the agent prompt', file: skill, phrase: 'Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.' },
  { reason: 'the round loop and its stop rule belong to the driver, not the session', file: skill, phrase: 'until the driver says the rounds are done' },
  { reason: 'local mode runs every seat and the verifier on one model in one session; it must be labelled as not independent', file: skill, phrase: '`--local` is not independent of this session' },
  { reason: 'every seat runs on the session model; the cross-vendor verifier of the default mode is gone', file: skill, phrase: "every seat and Quinn run on this session's model" },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not automatically retry failed or incomplete reviews' },
  { reason: 'a schema rejection gets one resend, not a loop', file: skill, phrase: 'send the error back and resend it once' },
  { reason: 'an export with missing turns is not a finished review', file: skill, phrase: 'an `incomplete` export is not a finished review' },
  { reason: 'the Notion engineering rules are mandatory for every Aspira agent, local mode included', file: skill, phrase: 'The engineering guidelines are mandatory' },
  { reason: 'local mode builds the guidelines folder the way load-knowledge does, from the pages the agent is configured with', file: skill, phrase: 'Build that folder with the Notion MCP' },
  { reason: 'a truncated or missing guideline page would review against rules the seats never saw', file: skill, phrase: 'If a page is truncated or cannot be fetched, stop and say so' },
  { reason: 'the packet needs REQUIRED.md, so the guidelines load before the PR', file: instructions, phrase: 'plus `knowledgeRequiredFile` set to the `requiredFile` load-knowledge returned' },
  { reason: 'the packet and the shas reach pr-debator through a file, never retyped by the model', file: instructions, phrase: 'the `label`, `repoPath` and `contextFile` from the `load-pr` result, exactly as returned' },
  { reason: 'a re-review is of a named previous review; a guessed directory re-reviews against the wrong findings', file: instructions, phrase: 'If `since` is missing from the request, ask for the directory; do not guess one' },
  { reason: 'a run the budget stopped has no fix list, and a verdict for it would be invented', file: instructions, phrase: 'A run the budget stopped has no verdict; do not invent one' },
  { reason: 'the shas the verdict applies to are reported, so a push after the review is visibly unreviewed', file: instructions, phrase: 'A push after this review is unreviewed' },
  { reason: 'the packet is complete for changed files; a seat that re-reads them pays for them twice', file: 'agent/subagents/ava/persona.md', phrase: 'The packet at the start of your prompt is complete for the changed files; reads are for unchanged files only' },
  { reason: 'a seat that holds out for fixes never agrees, and the review runs to the cap every time', file: 'agent/subagents/ava/persona.md', phrase: 'A finding of yours is settled once Quinn has ruled on it, whether or not anyone has fixed it' },
  { reason: 'in a re-review, a finding on unchanged code is out of scope, exactly as before', file: 'agent/subagents/quinn/persona.md', phrase: 'reject a new finding on code the delta does not change' },
  { reason: 'the estimate is information, not a gate; a launcher that waits for a yes blocks unattended runs', file: skill, phrase: 'The estimate is printed, not confirmed' },
  { reason: 'the stopping rule lives in the agent; the session must not decide whether another round runs', file: skill, phrase: "it applies the agent's stopping rule from `agent/lib/review.ts`" },
  { reason: 'the ticket is the argument; a path is the exception and must be asked for', file: skill, phrase: 'A file path only works with `--no-ticket`' },
  { reason: 'the gate runs before any model call, so a wrong Status costs nothing', file: skill, phrase: 'refused before any model call' },
  { reason: 'the reviewer owns no move; a session that moves cards on its own drifts from the board', file: skill, phrase: 'Never move a card anywhere the stage does not list' },
  { reason: 'a human owns every Ready column (BOARD-004)', file: skill, phrase: 'It never moves a card to a Ready column' },
  { reason: 'a push failure is reported with the local path, never hidden', file: skill, phrase: 'say so with the local path of the review and still' },
  { reason: 'a refused run made no model call and has nothing to export; exporting would present an empty review as one', file: instructions, phrase: 'do not call `export-review` or `comment-on-pr`' },
  { reason: 'the report starts with the ticket, the moves, the pages pushed and the working folder', file: skill, phrase: 'Start the report with the ticket ID and title' },
  { reason: 'the launcher owns the board work around a cloud run; the agent must not add a move', file: instructions, phrase: 'do not move the card yourself' },
  // The report rules of specs/agents-human-lists.md F5 live in the agent, where every mode reads them.
  { reason: 'a human reads the worst finding first; an unsorted list buries it', file: instructions, phrase: 'Present the findings in severity order (critical, high, medium, low, info)' },
  { reason: 'the plain-English line is what the author reads; the evidence is there when asked', file: instructions, phrase: 'each with its plain-English line first and its evidence available on request' },
  { reason: 'an open point without a recommendation sends the human back to the transcript', file: instructions, phrase: 'the option you would recommend with one sentence of reasoning, and why it is theirs to decide' },
  { reason: 'a summary that drops a finding hides it; the header count must equal the list', file: instructions, phrase: 'never summarise away an item' },
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

// The skill only runs the agent. Its rules live in agent/instructions.md and must not be
// restated in SKILL.md, or the two drift the first time the agent changes.
const agentRules = [
  'Never review the diff yourself',
  'The verdict is computed from the counts',
  'Post the review only to the PR that was loaded',
  'Skip it only when the person asked you not to comment',
  'Never write to `/workspace/findings.md`',
  'Do not argue with it',
]
const restatements = ['do not review the pr yourself', 'never to any other pr', 'no model chooses it', 'do not argue with', 'the verdict is computed', 'in severity order', 'plain-english line', 'evidence available on request', 'summarise away', 'option you would recommend']

it('the agent rules this file checks for are still in agent/instructions.md', () => {
  const text = readFileSync(join(root, instructions), 'utf8')
  for (const rule of agentRules.slice(0, 5)) expect(text).toContain(rule)
})

it(`${skill} points at agent/instructions.md and restates none of the agent's rules`, () => {
  const text = readFileSync(join(root, skill), 'utf8')
  expect(text).toContain('agent/instructions.md')
  for (const rule of [...agentRules, ...restatements]) expect(text.toLowerCase()).not.toContain(rule.toLowerCase())
})
