// The Playbook is the one source the "what to run next" table and the installed build-feature
// skill both read from. This imports it the way an installed package would: by the kit package's
// own name, through its public `./playbook` export, not a relative path into src/. It only runs
// after `pnpm --filter @aspiralabs/kit build` (the export resolves against dist, and self-reference
// needs the package's own "exports" map).
import { describe, expect, it } from 'vitest'
import { PLAYBOOK_STEPS, commandFor, nextStep } from '@aspiralabs/kit/playbook'

describe('the @aspiralabs/kit/playbook export', () => {
  it('resolves nextStep, commandFor and PLAYBOOK_STEPS by the package name', () => {
    expect(commandFor(nextStep('Ready: Spec')!, 'KIT-11')).toBe('/aspira-planner KIT-11')
    expect(nextStep('Shortlist')?.command).toBeNull()
    expect(nextStep('Nonsense')).toBeNull()
  })

  it('keeps the human Ready move on the manual path in Step 1, 4 and 5, naming the build-feature run-start approval as the one exception', () => {
    for (const title of ['Step 1: groom the idea', 'Step 4: approve the spec', 'Step 5: plan']) {
      const step = PLAYBOOK_STEPS.find((s: { title: string; body: string }) => s.title === title)
      expect(step, title).toBeDefined()
      const body = step!.body
      // The manual-path sentence: a human, not an agent, makes the Ready move by hand.
      expect(body, title).toMatch(/\bby hand\b|\byou\b[\s\S]*\bmove\b/i)
      // The one exception: the build-feature run-start approval makes this move itself.
      expect(body, title).toContain('/aspira-build-feature')
      expect(body.toLowerCase(), title).toContain('exception')
    }
  })
})
