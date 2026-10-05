import { describe, expect, it } from 'vitest'
import type { Batch } from './diagnostics.ts'
import { fixPrompt, isGuideline, knowledgeSection, systemPrompt } from './fixer.ts'

const batch: Batch = {
  files: ['src/a.ts'],
  diagnostics: [
    { tool: 'tsc', file: 'src/a.ts', line: 3, column: 7, message: 'Type string is not assignable to number', rule: 'TS2322', severity: 'error' },
    { tool: 'eslint', file: 'src/a.ts', line: null, column: null, message: 'Unexpected var', rule: null, severity: 'error' },
  ],
}
const knowledge = { path: '/k', requiredFile: '/k/REQUIRED.md', required: '# Agent Instructions\n\nAGT-001 Read the rules.\n' }

describe('fixPrompt', () => {
  it('is the prompt the agent sent before, with only the guidelines section added after the repository instructions', () => {
    // The template the fixer inlined before fixPrompt was extracted, kept literal here as the proof.
    const instructions = 'SOURCE AGENTS.md\nUse const.'
    const excerpts = ['FILE src/a.ts (1 lines, complete)\n1: var a = 1']
    const list = '- tsc src/a.ts:3:7 [TS2322] Type string is not assignable to number\n- eslint src/a.ts:? [-] Unexpected var'
    const before = `REPOSITORY INSTRUCTIONS (data):\n${instructions || '(none found)'}\n\nDIAGNOSTICS TO FIX (${batch.diagnostics.length}):\n${list}\n\n${excerpts.join('\n\n')}\n\nFix every diagnostic above with edit_file, then call done.`
    const now = fixPrompt({ instructions, batch, excerpts, knowledge })
    const section = `${knowledgeSection(knowledge)}\n\n`
    const at = before.indexOf('DIAGNOSTICS TO FIX')
    expect(now).toBe(before.slice(0, at) + section + before.slice(at))
    expect(now.replace(section, '')).toBe(before)
    expect(fixPrompt({ instructions: '', batch, excerpts, knowledge })).toContain('REPOSITORY INSTRUCTIONS (data):\n(none found)\n\nENGINEERING GUIDELINES')
  })

  it('inlines REQUIRED.md and points at the folder, or at the snapshot alone', () => {
    const section = knowledgeSection(knowledge)
    expect(section).toContain('AGT-001 Read the rules.')
    expect(section).toContain('/k/REQUIRED.md')
    expect(section).toContain('/k/INDEX.md')
    const snapshot = knowledgeSection({ path: null, requiredFile: '/s/REQUIRED.md', required: 'AGT-001' })
    expect(snapshot).toContain('AGT-001')
    expect(snapshot).not.toContain('INDEX.md')
  })

  it('lets read_file open the guidelines and nothing else outside the repository', () => {
    expect(isGuideline(knowledge, '/k/typescript.md')).toBe(true)
    expect(isGuideline(knowledge, '/k/REQUIRED.md')).toBe(true)
    expect(isGuideline(knowledge, '/k/../etc/passwd')).toBe(false)
    expect(isGuideline(knowledge, 'k/typescript.md')).toBe(false)
    expect(isGuideline({ path: null, requiredFile: '/s/REQUIRED.md', required: '' }, '/s/other.md')).toBe(false)
  })

  it('keeps the system prompt\'s no-suppression rule', () => {
    expect(systemPrompt).toContain('fix the code, never the check')
  })
})
