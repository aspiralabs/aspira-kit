// Rules that earned their place in the skill, each pinned by the sentence that
// carries it. A rewrite that drops the sentence reads as a harmless tidy-up;
// this test makes it a failure with the reason attached. Rewording is fine:
// update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'skill/aspira-spec-writer/SKILL.md'
const instructions = 'agent/instructions.md'

const rules = [
  { reason: 'the agent is the single source of truth; the skill only runs it', file: skill, phrase: 'This skill only runs the official spec-writer agent' },
  { reason: 'the routing and reporting rules live in the agent and are read at runtime, never restated here', file: skill, phrase: 'read the file named in `orchestrator` in full' },
  { reason: 'the idea is source data; embellishing it hides choices the review should surface', file: skill, phrase: 'Never rewrite or embellish the idea' },
  { reason: 'local mode is only faithful if each phase gets the exact agent prompt', file: skill, phrase: 'do not edit the prompt files' },
  { reason: 'the six specialists are independent lenses; run one after another they cost six times the wall clock', file: skill, phrase: 'Launch all six subagents **in one message**' },
  { reason: 'a subagent told anything beyond the file names drifts from the agent prompt', file: skill, phrase: 'Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.' },
  { reason: 'a schema rejection gets one resend, not a loop', file: skill, phrase: 'send that error back once' },
  { reason: 'the Notion engineering rules are mandatory for every Aspira agent, local mode included', file: skill, phrase: 'The engineering guidelines are mandatory' },
  { reason: 'local mode builds the guidelines folder the way load-knowledge does, from the pages the agent is configured with', file: skill, phrase: 'Build that folder with the Notion MCP' },
  { reason: 'a truncated or missing guideline page would write and review against rules the phases never saw', file: skill, phrase: 'If a page is truncated or cannot be fetched, stop and say so' },
  { reason: 'local mode runs on one vendor and one session; it must be labelled as not independent', file: skill, phrase: 'its review is not independent of the writer' },
  { reason: 'a failed rerun must not be papered over with the previous report', file: skill, phrase: 'do not present an earlier report as the new result' },
  { reason: 'the idea file is never edited in place', file: skill, phrase: 'The idea file is never modified' },
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
  'Do not write or review the spec yourself',
  'never write a spec without it',
  'Do not retry incomplete results automatically',
  'An incomplete run is not a spec to plan from',
  'A ready spec is still a proposal for the author to accept',
]
const restatements = ['write the spec yourself', 'not a spec to plan from', 'retry a failed or incomplete', 'proposal for the author', 'notion.com/p/']

it('the agent rules this file checks for are still in agent/instructions.md', () => {
  const text = readFileSync(join(root, instructions), 'utf8')
  for (const rule of agentRules) expect(text).toContain(rule)
})

it(`${skill} points at agent/instructions.md and restates none of the agent's rules`, () => {
  const text = readFileSync(join(root, skill), 'utf8')
  expect(text).toContain('agent/instructions.md')
  for (const rule of [...agentRules, ...restatements]) expect(text.toLowerCase()).not.toContain(rule.toLowerCase())
})
