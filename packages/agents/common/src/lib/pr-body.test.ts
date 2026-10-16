// pr-body.ts does not exist yet (KIT-2, P22): this file and pr-body-redaction.test.ts are its
// contract, written before the module (TEST-005: the seam is the markdown string renderPrBody
// returns). T33 covers the three-section shape, the Summary file tree, and Evidence grouped by
// feature ID with each fragment tailed to its last 20 lines; T35 covers Merge Danger's one-way
// versus two-way choice; T36 covers Evidence's "no static analysis ran" line for a no-analyzers
// code-analyzer result.
//
// Contract assumed here (plan.json task P22 reads this as the spec it implements):
// renderPrBody({ ticket, implementationMd, changedFiles, analyzers, taken?, notice?, repo, app? })
// returns one markdown string whose `## ` sections are, in order: Summary (a file tree of
// changedFiles, generated in code), Evidence (per feature ID, every `## Tasks` row in
// implementationMd whose Features column names it, with that task's red and green evidence, each
// fragment at most the last 20 lines) and Merge Danger (a one-way door when implementationMd's
// `## Dependencies added` flags a native addition or a changedFiles path is under a migrations
// directory, else a two-way door), followed by the ticket link.
//
// implementationMd's shape this renderer parses (greenfield: research found no code or fixture in
// this repo that predates this feature; the implementor's own SKILL.md template fixes the Tasks
// table's header row and nothing else about how a cell holds red/green evidence, so this is the
// convention the fixtures below assume and P22 must satisfy):
// - `## Tasks` is a pipe table `| Task | Features | Lane/wave | Status | Commit | Red → green
//   evidence |` whose last column is one of the words `red`, `green` or `none`, naming which
//   evidence that task recorded.
// - Immediately under the table, each task that recorded evidence has its own
//   `### <task id> — red → green evidence` subsection: a `- red: \`<command>\`` line followed by a
//   fenced block of the failing output, and/or a `- green: \`<command>\` exited <code>` line.
// - `## Dependencies added` lists `- \`<name>\` <version> (<app>, <scope>): native: true|false;
//   approval: <word>.` bullets, or `None.` when the build added nothing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPrBody } from './pr-body'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-body-'))
  temps.push(dir)
  return dir
}

const ticket = { id: 'KIT-2', title: 'Every skill writes a progress note', url: 'https://app.notion.com/p/kit-2-0000000000000000000000000002' }

/** The `## ` sections in order, each with its heading and body (summary.test.ts's convention). */
function sections(markdown: string): { heading: string; body: string }[] {
  const parts = markdown.split(/^(?=## )/m).filter((part) => part.startsWith('## '))
  return parts.map((part) => {
    const [heading = '', ...body] = part.split('\n')
    return { heading: heading.slice(3), body: body.join('\n') }
  })
}
const section = (markdown: string, heading: RegExp): string => sections(markdown).find((entry) => heading.test(entry.heading))?.body ?? ''

const redLines = (count: number): string[] => Array.from({ length: count }, (_, index) => `red-line-${String(index + 1).padStart(2, '0')}`)

/** P1 (tests, F1): a red line of 30 lines of output. P2 (implementation, F1): a green line. P3 (tests, F2): no red line. */
function tasksFixture(): string {
  return [
    '# Implementation',
    'Source: ticket KIT-2  Status: done   Branch: feat/kit-2-x',
    '',
    '## Tasks',
    '',
    '| Task | Features | Lane/wave | Status | Commit | Red → green evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    '| P1 | F1 | wave 1 | done | abc1111 | red |',
    '| P2 | F1 | wave 1 | done | abc2222 | green |',
    '| P3 | F2 | wave 1 | done | abc3333 | none |',
    '',
    '### P1 — red → green evidence',
    '',
    '- red: `pnpm --filter x vitest run src/feature.test.ts`',
    '',
    '```text',
    redLines(30).join('\n'),
    '```',
    '',
    '### P2 — red → green evidence',
    '',
    '- green: `pnpm --filter x vitest run src/feature.test.ts` exited 0',
    '',
    '## Features',
    '',
    '| Feature | Tasks | Tests | Passing |',
    '| --- | --- | --- | --- |',
    '| F1 | P1, P2 | T1 | yes |',
    '| F2 | P3 | T2 | no |',
    '',
    '## Dependencies added',
    '',
    'None.',
    '',
    '## Mid-build notes',
    '',
    'None.',
    '',
    '## Proposed Slop Repo entries',
    '',
    'None: no bugs were found and fixed',
    '',
  ].join('\n')
}

describe('renderPrBody (T33): Summary, Evidence and Merge Danger', () => {
  const changedFiles = ['packages/a/x.ts', 'packages/a/x.test.ts']

  it('has the sections Summary, Evidence and Merge Danger in that order and links the ticket URL', async () => {
    const body = await renderPrBody({ ticket, implementationMd: tasksFixture(), changedFiles, analyzers: [], repo: await tempRepo() })
    const headings = sections(body).map((entry) => entry.heading.toLowerCase())
    const order = ['summary', 'evidence', 'merge danger'].map((name) => headings.indexOf(name))
    const found = order.every((index) => index >= 0)
    const inOrder = found && order.every((index, i) => i === 0 || index > order[i - 1]!)
    expect({ inOrder, linksTicket: body.includes(ticket.url) }).toEqual({ inOrder: true, linksTicket: true })
  })

  it('renders Summary as a file tree naming every changed file', async () => {
    const body = await renderPrBody({ ticket, implementationMd: tasksFixture(), changedFiles, analyzers: [], repo: await tempRepo() })
    const summary = section(body, /^summary$/i)
    expect(changedFiles.every((file) => summary.includes(file))).toBe(true)
  })

  it('lists F1 under Evidence, with P1’s red fragment and P2’s green fragment', async () => {
    const body = await renderPrBody({ ticket, implementationMd: tasksFixture(), changedFiles, analyzers: [], repo: await tempRepo() })
    const evidence = section(body, /^evidence$/i)
    expect({ named: evidence.includes('F1'), hasRed: evidence.includes('vitest run src/feature.test.ts'), hasGreen: evidence.includes('exited 0') }).toEqual({ named: true, hasRed: true, hasGreen: true })
  })

  it('lists F2 as "no recorded red run", since only P3 (no red line) names it', async () => {
    const body = await renderPrBody({ ticket, implementationMd: tasksFixture(), changedFiles, analyzers: [], repo: await tempRepo() })
    const evidence = section(body, /^evidence$/i)
    expect(evidence.includes('F2') && evidence.includes('no recorded red run')).toBe(true)
  })

  it('tails P1’s red fragment to its last 20 lines, dropping the earliest ones', async () => {
    const body = await renderPrBody({ ticket, implementationMd: tasksFixture(), changedFiles, analyzers: [], repo: await tempRepo() })
    const evidence = section(body, /^evidence$/i)
    const kept = redLines(30).slice(-20).every((line) => evidence.includes(line))
    const droppedAny = redLines(30).slice(0, 10).some((line) => evidence.includes(line))
    expect({ kept, droppedAny }).toEqual({ kept: true, droppedAny: false })
  })
})

describe('renderPrBody (T36): Evidence says no static analysis ran for a no-analyzers app', () => {
  const emptyTasks = ['# Implementation', '', '## Tasks', '', '| Task | Features | Lane/wave | Status | Commit | Red → green evidence |', '| --- | --- | --- | --- | --- | --- |', ''].join('\n')

  it('names the app and says no static analysis ran, for a rounds.json of status ready, reasonCode no-analyzers', async () => {
    const body = await renderPrBody({ ticket, implementationMd: emptyTasks, changedFiles: [], analyzers: [{ app: 'apps/web', status: 'ready', reasonCode: 'no-analyzers' }], repo: await tempRepo() })
    const evidence = section(body, /^evidence$/i)
    expect({ namesApp: evidence.includes('apps/web'), saysNoAnalysis: evidence.toLowerCase().includes('no static analysis ran') }).toEqual({ namesApp: true, saysNoAnalysis: true })
  })
})

describe('renderPrBody (T35): Merge Danger names a one-way door for a native build or a migration, else two-way', () => {
  const emptyTasksTable = ['# Implementation', '', '## Tasks', '', '| Task | Features | Lane/wave | Status | Commit | Red → green evidence |', '| --- | --- | --- | --- | --- | --- |', ''].join('\n')

  function withDependency(nativeFlagged: boolean): string {
    const dependency = nativeFlagged ? '- `left-pad` 1.3.0 (root, runtime): native: true; approval: not listed.' : '- `axios` 1.6.0 (root, runtime): native: false; approval: Adopt.'
    return `${emptyTasksTable}\n## Dependencies added\n\n${dependency}\n`
  }

  const cases: { name: string; implementationMd: string; changedFiles: string[]; expected: 'one-way' | 'two-way' }[] = [
    { name: 'a native dependency, no migration', implementationMd: withDependency(true), changedFiles: ['packages/a/x.ts'], expected: 'one-way' },
    { name: 'no native dependency, a migration path', implementationMd: withDependency(false), changedFiles: ['packages/db/migrations/001.sql'], expected: 'one-way' },
    { name: 'neither a native dependency nor a migration path', implementationMd: withDependency(false), changedFiles: ['packages/a/x.ts'], expected: 'two-way' },
  ]

  for (const { name, implementationMd, changedFiles, expected } of cases) {
    it(`names a ${expected} door for ${name}`, async () => {
      const body = await renderPrBody({ ticket, implementationMd, changedFiles, analyzers: [], repo: await tempRepo() })
      const danger = section(body, /^merge danger$/i)
      const other = expected === 'one-way' ? 'two-way' : 'one-way'
      expect({ namesExpected: danger.includes(`${expected} door`), namesOther: danger.includes(`${other} door`) }).toEqual({ namesExpected: true, namesOther: false })
    })
  }
})
