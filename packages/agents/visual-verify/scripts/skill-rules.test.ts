// Rules of the /aspira-visual-verify check, each pinned by the wording the spec gives it (KIT-58
// Features F2-F7, F13, F15, F20). A rewrite that drops a rule reads as a harmless tidy-up; this
// test makes it a failure with the reason attached. The phrases come from the spec, not from the
// SKILL.md: rewording the skill is fine as long as the rule stays in it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const text = (() => {
  try {
    return readFileSync(join(root, 'skill/aspira-visual-verify/SKILL.md'), 'utf8')
  } catch {
    return ''
  }
})()

const present: { reason: string; phrase: string }[] = [
  { reason: 'the Chrome tool is Claude-in-Chrome (Q4)', phrase: 'Claude-in-Chrome' },
  { reason: 'or a Chrome DevTools MCP (Q4)', phrase: 'Chrome DevTools MCP' },
  { reason: 'a server that does not answer within the wait skips the step (F2)', phrase: '60 s' },
  { reason: 'clipping is judged at one named desktop viewport (F6)', phrase: '1280px' },
  { reason: 'a Feature with no page is never counted as passed (F3)', phrase: 'not exercised: no page found' },
  { reason: 'an action no Feature names is listed, not clicked (F7)', phrase: 'not exercised: not named by a Feature' },
  { reason: 'screenshots stay under the ticket folder (F3, F15)', phrase: '.work/<id>/visual-verify/' },
]

describe('SKILL.md keeps the rules the spec pins', () => {
  for (const { reason, phrase } of present) {
    it(`keeps ${phrase}: ${reason}`, () => {
      expect(text).toContain(phrase)
    })
  }

  it('names no browser tool besides Claude-in-Chrome and a Chrome DevTools MCP (Q4)', () => {
    expect({ exists: text !== '', other: ['playwright', 'puppeteer', 'selenium', 'cypress', 'browserbase'].filter((tool) => text.toLowerCase().includes(tool)) }).toEqual({ exists: true, other: [] })
  })

  it('never types a credential: the human signs in (F13)', () => {
    expect(text).toMatch(/never types? a credential/i)
  })

  it('never records headers, cookies or bodies of a failed request (F4)', () => {
    expect(text).toMatch(/never[^.]*headers, cookies,? or bodies/i)
  })

  it('grades a field empty or a dash in every row as a blocker (F5, SIFT-8 prices)', () => {
    expect(text).toMatch(/blocker[\s\S]{0,400}?(?:empty or (?:a )?dash(?:ed)?)[\s\S]{0,100}?every row/i)
  })

  it('grades a clipped column as a blocker (F6, SIFT-8 columns)', () => {
    expect(text).toMatch(/blocker[\s\S]{0,600}?clipped/i)
  })

  it('never attaches a screenshot to Notion, the PR or the commit (F15)', () => {
    expect(text).toMatch(/never attach[a-z]*[^.]*Notion[^.]*PR[^.]*commit/i)
  })
})
