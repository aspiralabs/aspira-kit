// KIT-54: the one research rule is in every cloud agent's instructions, verbatim, and the session
// tool note names the Notion read tools. An instructions file that drops or rewords the rule fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RESEARCH_RULE, RESEARCH_RULE_MARKER, sessionResearchTools } from './research-rule.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')
const AGENTS = ['groomer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'spec-writer']

it('every cloud agent\'s instructions.md carries the research rule verbatim', () => {
  const missing = AGENTS.filter((agent) => !readFileSync(join(ROOT, 'packages', 'ai', agent, 'agent', 'instructions.md'), 'utf8').includes(RESEARCH_RULE))
  expect(missing).toEqual([])
  expect(RESEARCH_RULE.startsWith(RESEARCH_RULE_MARKER)).toBe(true)
})

it('the session tool note names the repository, the Notion read tools (pages, search, database rows) and the web, read-only', () => {
  const note = sessionResearchTools('/repo')
  expect(['/repo', 'notion-fetch', 'notion-search', 'notion-query-data-sources', 'WebFetch', 'Never a write'].every((word) => note.includes(word))).toBe(true)
})
