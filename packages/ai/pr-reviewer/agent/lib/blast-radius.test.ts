import { describe, expect, it } from 'vitest'
import { blockingFindings } from '../../../build-feature/src/review-loop.ts'
import { countsFromFindings, sortFindingsMarkdown } from './findings.ts'
import { outsideBlastRadius, parseBlastRadius, withBlastRadiusFinding, type ChangedPath } from './blast-radius.ts'

// The contract these suites pin, where the plan leaves a name open (KIT-70 A9, F12, F13):
//   parseBlastRadius(spec, tracked, packages)  packages maps a workspace package name to its directory;
//                                              returns { declared, unresolved }, both in order of appearance.
//   outsideBlastRadius(changed, declared)      changed entries are { status, path, oldPath? } (git name-status:
//                                              path is the new path of a rename and the old path of a deletion);
//                                              returns { files, more } or null when every file is inside.
//   withBlastRadiusFinding(findings, check)    check is { outside, specFile, entries }; findings.md text in and out.

const TRACKED = [
  'README.md',
  'docs/x.md',
  'packages/ai/common/src/lib/a.ts',
  'packages/ai/common/src/lib/b.ts',
  'packages/ai/pr-reviewer/agent/lib/findings.ts',
  'packages/ai/spec-writer/agent/lib/local.ts',
  'packages/ai/spec-writer/agent/lib/writer.ts',
  'packages/ai/spec-writer/agent/lib/other.ts',
  'packages/ui/src/button.tsx',
]
const PACKAGES = { '@aspiralabs/ui': 'packages/ui', '@aspiralabs/ai': 'packages/ai' }

const SPEC = [
  '# Spec',
  '',
  '## Approach',
  '',
  '- `README.md` is mentioned here but outside the section.',
  '',
  '## Blast radius',
  '',
  '- `packages/ai/spec-writer/agent/lib/local.ts`, then `writer.ts` (the seam)',
  '- `packages/ai/common` (the helper)',
  '- `@aspiralabs/ui` tokens',
  '- Excluded:',
  '  - `docs/x.md` (not touched)',
  '  - `packages/ai/pr-reviewer/agent/lib/findings.ts` (unchanged)',
  '- `packages/ai/**/*.ts` (a glob)',
  '- `nothing-here.ts` (a bare name that resolves nowhere)',
  '',
  '## Constraints',
  '',
  '- `docs/x.md` again, outside the section.',
  '',
].join('\n')

describe('T20: parseBlastRadius', () => {
  it('declares full paths, a bare name after a full path in the same bullet, a directory and a workspace package directory', () => {
    const parsed = parseBlastRadius(SPEC, TRACKED, PACKAGES)
    expect([...parsed.declared].sort()).toEqual([
      'packages/ai/common',
      'packages/ai/spec-writer/agent/lib/local.ts',
      'packages/ai/spec-writer/agent/lib/writer.ts',
      'packages/ui',
    ])
  })

  it('does not declare the Excluded: sub-list or anything outside the section', () => {
    const { declared } = parseBlastRadius(SPEC, TRACKED, PACKAGES)
    expect(declared).not.toContain('docs/x.md')
    expect(declared).not.toContain('README.md')
    expect(declared).not.toContain('packages/ai/pr-reviewer/agent/lib/findings.ts')
  })

  it('lists globs and names that resolve nowhere as unresolved, never as declared', () => {
    const { declared, unresolved } = parseBlastRadius(SPEC, TRACKED, PACKAGES)
    expect([...unresolved].sort()).toEqual(['nothing-here.ts', 'packages/ai/**/*.ts'])
    expect(declared).not.toContain('nothing-here.ts')
    expect(declared).not.toContain('packages/ai/**/*.ts')
  })

  it('does not resolve a bare name against a directory that does not hold it', () => {
    const spec = '## Blast radius\n\n- `packages/ai/common/src/lib/a.ts`, then `writer.ts`\n'
    const parsed = parseBlastRadius(spec, TRACKED, PACKAGES)
    expect(parsed.declared).toEqual(['packages/ai/common/src/lib/a.ts'])
    expect(parsed.unresolved).toEqual(['writer.ts'])
  })

  it('gives an empty declaration for a section that names nothing, and for a spec with no section', () => {
    expect(parseBlastRadius('## Blast radius\n\nNothing outside the helper; no other file changes.\n', TRACKED, PACKAGES)).toEqual({ declared: [], unresolved: [] })
    expect(parseBlastRadius('# Spec\n\n## Approach\n\n- `README.md`\n', TRACKED, PACKAGES).declared).toEqual([])
  })
})

describe('T21: outsideBlastRadius', () => {
  const declared = ['packages/ai/common', 'packages/ai/spec-writer/agent/lib/local.ts']

  it('judges a rename by its new path and a deletion by its old path', () => {
    const changed: ChangedPath[] = [
      { status: 'R', path: 'packages/ai/common/src/lib/new.ts', oldPath: 'elsewhere/old.ts' },
      { status: 'R', path: 'elsewhere/moved.ts', oldPath: 'packages/ai/common/src/lib/old.ts' },
      { status: 'D', path: 'packages/ai/common/src/lib/gone.ts' },
      { status: 'D', path: 'docs/gone.md' },
      { status: 'M', path: 'packages/ai/spec-writer/agent/lib/local.ts' },
    ]
    expect(outsideBlastRadius(changed, declared)).toEqual({ files: ['docs/gone.md', 'elsewhere/moved.ts'], more: 0 })
  })

  it('lists the outside files in ascending order, 25 of them, then counts the rest', () => {
    const outside = Array.from({ length: 30 }, (_, index) => `z/f${String(index + 1).padStart(2, '0')}.ts`)
    const shuffled = [...outside].reverse()
    const changed: ChangedPath[] = [...shuffled.map((path): ChangedPath => ({ status: 'M', path })), { status: 'M', path: 'packages/ai/common/src/lib/a.ts' }]
    const result = outsideBlastRadius(changed, declared)
    expect(result?.files).toEqual(outside.slice(0, 25))
    expect(result?.more).toBe(5)
  })

  it('gives no finding when every changed file is inside', () => {
    const changed: ChangedPath[] = [
      { status: 'M', path: 'packages/ai/common/src/lib/a.ts' },
      { status: 'A', path: 'packages/ai/spec-writer/agent/lib/local.ts' },
    ]
    expect(outsideBlastRadius(changed, declared)).toBeNull()
  })

  it('does not treat a sibling directory with a shared name prefix as inside', () => {
    expect(outsideBlastRadius([{ status: 'M', path: 'packages/ai/common-extra/a.ts' }], declared)).toEqual({ files: ['packages/ai/common-extra/a.ts'], more: 0 })
  })
})

describe('T22: withBlastRadiusFinding', () => {
  const entry = (id: string, title: string) => `### [${id}] ${title}\n- **Location:** \`a.ts:1\`\n- **Evidence:** \`x\`\n`
  const PREVIOUS = [
    '# Findings: o/r#2',
    '',
    'Totals: 9 critical · 9 high · 9 medium · 9 low · 9 info',
    '',
    '## High',
    '',
    entry('AVA1.1', 'Unchecked input'),
    '## Low',
    '',
    entry('DEX1.1', 'Naming'),
    entry('BLAST1.1', 'Blast radius: 1 changed file outside the spec'),
    '- **Files:** `old-outside.ts`',
    '',
  ].join('\n')
  const check = { outside: { files: ['b.ts', 'c.ts', 'd.ts'], more: 2 }, specFile: 'spec.reviewed/spec.reviewed.md', entries: ['a.ts', 'packages/ui'] }

  it('puts exactly one Blast radius entry under ## Low, replacing the previous one, naming the count, the spec file and the entries', () => {
    const text = sortFindingsMarkdown(withBlastRadiusFinding(PREVIOUS, check))
    expect(text.match(/^### \[[^\]]+\] Blast radius/gm)).toHaveLength(1)
    const low = text.slice(text.indexOf('## Low'))
    const blast = low.slice(low.search(/^### \[[^\]]+\] Blast radius/m))
    expect(blast).toContain('5')
    expect(blast).toContain('spec.reviewed/spec.reviewed.md')
    expect(blast).toContain('a.ts')
    expect(blast).toContain('packages/ui')
    for (const file of check.outside.files) expect(blast).toContain(file)
    expect(blast).toContain('+2 more')
    expect(text).not.toContain('old-outside.ts')
    expect(text).toContain('### [DEX1.1] Naming')
  })

  it('creates the ## Low section when the file has none', () => {
    const text = sortFindingsMarkdown(withBlastRadiusFinding('# Findings: o/r#3\n\nTotals: 0 critical · 0 high · 0 medium · 0 low · 0 info\n', check))
    expect(text).toMatch(/## Low\n[\s\S]*### \[[^\]]+\] Blast radius/)
    expect(countsFromFindings(text)).toEqual({ critical: 0, high: 0, medium: 0, low: 1, info: 0 })
  })

  it('recomputes the Totals line and leaves the blocking findings as they were', () => {
    const text = sortFindingsMarkdown(withBlastRadiusFinding(PREVIOUS, check))
    expect(text).toContain('Totals: 0 critical · 1 high · 0 medium · 2 low · 0 info')
    expect(countsFromFindings(text)).toEqual({ critical: 0, high: 1, medium: 0, low: 2, info: 0 })
    const blocking = blockingFindings(text)
    expect(blocking.ok).toBe(true)
    if (blocking.ok) expect(blocking.findings.map((finding) => finding.id)).toEqual(['AVA1.1'])
  })

  it('is idempotent: adding the same check twice leaves one entry', () => {
    const once = withBlastRadiusFinding(PREVIOUS, check)
    expect(sortFindingsMarkdown(withBlastRadiusFinding(once, check))).toBe(sortFindingsMarkdown(once))
  })
})
