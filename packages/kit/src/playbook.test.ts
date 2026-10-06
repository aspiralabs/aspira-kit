import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkAspira, isNotionUrl, writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { next, readWorkTicket, type Resolver } from './next.js'
import { PLAYBOOK, PLAYBOOK_STEPS, commandFor, nextStep, renderPlaybook } from './playbook.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6?v=b4e393d4a4a646b8bbd13d6c0f45a01e'
const STATUSES = ['Idea', 'Grooming', 'Shortlist', 'Ready: Idea', 'In Progress: Spec', 'In Review: Spec', 'Ready: Spec', 'In Progress: Plan', 'In Review: Plan', 'Ready: Plan', 'In Progress: Implementation', 'In Review: Implementation', 'Ready: Implementation', 'Released', 'Dropped']

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-playbook-'))
})

const ticketMd = (id: string, title: string, status: string, url = 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1') =>
  `# ${id}: ${title}\n\n| Field | Value |\n| --- | --- |\n| ID | ${id} |\n| URL | ${url} |\n| Status | ${status} |\n| Pulled | 2026-10-06T00:00:00.000Z |\n\n## Pages\n\n| Title | URL | Last edited |\n| --- | --- | --- |\n\n## Idea\n\nAn idea.\n`

describe('the Playbook module', () => {
  it('has a row for every Feature Board Status, with the ticket form of each command', () => {
    for (const status of STATUSES) expect(nextStep(status), status).not.toBeNull()
    expect(nextStep('ready: spec')?.command).toBe('/aspira-planner <ID> --local')
    expect(nextStep('Nope')).toBeNull()
    for (const row of PLAYBOOK) if (row.command !== null) expect(row.command).toMatch(/^\/aspira-[a-z-]+ <ID>( <app-dir>)? --local$/)
    expect(commandFor(nextStep('In Review: Implementation')!, 'NOM-4')).toBe('/aspira-pr-reviewer NOM-4 --local')
    expect(commandFor(nextStep('Released')!, 'NOM-4')).toBeNull()
  })

  it('renders the Playbook section that From Idea to Release carries, from the same rows, with no emoji', () => {
    const markdown = renderPlaybook()
    expect(markdown.startsWith('## Playbook: what to run next\n')).toBe(true)
    for (const row of PLAYBOOK) expect(markdown).toContain(`| ${row.statuses.join(', ')} | ${row.step} | ${row.command === null ? 'by hand' : `\`${row.command}\``} | ${row.who} |`)
    for (const step of PLAYBOOK_STEPS) expect(markdown).toContain(`### ${step.title}\n${step.body}`)
    expect(markdown).not.toContain('manual today')
    expect(markdown).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(PLAYBOOK_STEPS.map((step) => step.title.split(':')[0])).toEqual(Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`))
  })
})

describe('kit next', () => {
  const resolver = (status: string): Resolver => (board, ref) => (board === BOARD && /^nom-4$/i.test(ref) ? { id: 'NOM-4', title: 'Explore pagination', url: 'https://www.notion.so/x', status } : null)
  const run = (ref: string | undefined, resolve: Resolver) => {
    const lines: string[] = []
    const code = next(root, ref, (line) => lines.push(line), resolve)
    return { code, lines }
  }

  it('prints the Status, the step, the command with the ID and who acts, for every Status, from the Playbook module', () => {
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
    for (const status of STATUSES) {
      const { code, lines } = run('NOM-4', resolver(status))
      const row = nextStep(status)!
      expect(code, status).toBe(0)
      expect(lines).toEqual([
        'ticket   NOM-4 Explore pagination (https://www.notion.so/x)',
        `status   ${status}`,
        `next     ${row.step}`,
        `run      ${commandFor(row, 'NOM-4') ?? 'by hand, on the board'}`,
        `who      ${row.who}`,
      ])
    }
  })

  it('needs aspira.json, takes the one working folder when no ticket is given, and names two', () => {
    expect(run('NOM-4', resolver('Ready: Spec')).lines[0]).toContain('no aspira.json')
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
    expect(run(undefined, resolver('Ready: Spec')).lines[0]).toContain('no folder under .work/')
    mkdirSync(join(root, '.work', 'nom-4-explore-pagination'), { recursive: true })
    writeFileSync(join(root, '.work', 'nom-4-explore-pagination', 'ticket.md'), ticketMd('NOM-4', 'Explore pagination', 'In Review: Spec'))
    expect(readWorkTicket(join(root, '.work', 'nom-4-explore-pagination'))).toEqual({ id: 'NOM-4', title: 'Explore pagination', url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1', status: 'In Review: Spec' })
    const one = run(undefined, resolver('Ready: Spec'))
    expect(one.code).toBe(0)
    expect(one.lines[1]).toBe('status   Ready: Spec')
    // The board does not answer: the Status as pulled stands in, and the output says so.
    const offline = run(undefined, () => null)
    expect(offline.code).toBe(0)
    expect(offline.lines[1]).toBe('status   In Review: Spec (as pulled into the working folder; the board did not answer)')
    expect(offline.lines[3]).toBe('run      /aspira-spec-reviewer NOM-4 --local')
    mkdirSync(join(root, '.work', 'nom-5-find-cooks'), { recursive: true })
    writeFileSync(join(root, '.work', 'nom-5-find-cooks', 'ticket.md'), ticketMd('NOM-5', 'Find cooks', 'Ready: Idea', 'https://www.notion.so/5'))
    expect(run(undefined, resolver('Ready: Spec')).lines[0]).toContain('2 folders under .work/ hold a ticket.md')
    expect(run('spec.md', resolver('Ready: Spec')).code).toBe(2)
    expect(run('NOM-9', resolver('Ready: Spec')).lines[0]).toContain('cannot resolve NOM-9')
  })
})

describe('aspira.json', () => {
  it('kit init --board writes it, keeps it when unchanged, and refuses a URL that is not Notion', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    expect(() => writeAspira({ projectRoot: root, board: 'https://example.com/board', dryRun: false, log })).toThrow('--board must be the Feature Board')
    writeAspira({ projectRoot: root, board: BOARD, dryRun: false, log })
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD })
    expect(lines.at(-1)).toContain('write  ')
    writeAspira({ projectRoot: root, board: BOARD, dryRun: false, log })
    expect(lines.at(-1)).toContain('keep   ')
    writeAspira({ projectRoot: root, releases: 'https://app.notion.com/p/3f13e59b22588106ab5dc457a42b0e1c', dryRun: false, log })
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD, releases: 'https://app.notion.com/p/3f13e59b22588106ab5dc457a42b0e1c' })
    expect(lines.at(-1)).toContain('update ')
    writeAspira({ projectRoot: join(root, 'other'), dryRun: false, log })
    expect(lines.at(-1)).toContain('skip   ')
    expect(isNotionUrl('collection://b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e')).toBe(true)
    expect(isNotionUrl('https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad')).toBe(true)
  })

  it('kit doctor fails without it, or when board is not a Notion URL', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"app"}')
    const report = () => {
      const lines: string[] = []
      const code = doctor(root, (line) => lines.push(line))
      return { code, lines }
    }
    expect(checkAspira(root)).toEqual({ ok: false, reason: 'aspira.json is missing; run kit init --board <Feature Board URL>' })
    let out = report()
    expect(out.code).toBe(1)
    expect(out.lines).toContain('FAIL aspira.json is missing; run kit init --board <Feature Board URL>')
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: 'https://example.com/board' }))
    out = report()
    expect(out.lines.some((line) => line.startsWith('FAIL aspira.json has no "board" Notion URL'))).toBe(true)
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
    out = report()
    expect(out.lines).toContain('ok   aspira.json names the Feature Board')
  })
})
