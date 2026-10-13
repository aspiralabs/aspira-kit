// The counts behind a PR review verdict, shared so every reader of a findings.md agrees on them
// (F27; KIT-11 plan P2 T7). Pure: text in, counts out.

import { describe, expect, it } from 'vitest'
import { countsFromFindings } from '@aspiralabs/agent-common/lib/findings-counts'

describe('counting findings by severity (T7)', () => {
  const findings = [
    '# Findings',
    '',
    '## Critical',
    '',
    '### [S1-1] A critical finding',
    '',
    '**What this means:** something breaks badly for a user.',
    '',
    '## High',
    '',
    '### [S1-1] A high finding',
    '',
    '**What this means:** something breaks for a user.',
    '',
    '### [S1-1] Another high finding',
    '',
    '**What this means:** something else breaks for a user.',
    '',
    '## Low',
    '',
    '### [S1-1] A low finding',
    '',
    '**What this means:** a minor issue a user may notice.',
    '',
  ].join('\n')

  it('counts the entries under each severity heading', () => {
    expect(countsFromFindings(findings)).toEqual({ critical: 1, high: 2, medium: 0, low: 1, info: 0 })
  })

  it('returns null for text with no "# Findings" title', () => {
    expect(countsFromFindings('Just some notes, not a findings file.')).toBeNull()
  })
})
