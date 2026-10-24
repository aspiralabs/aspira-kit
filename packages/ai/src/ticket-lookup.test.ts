// lookupTicket and liveResolver over the installed @aspiralabs/ai common resolve script. The script is the
// process boundary (TEST-007): each case writes a fake scripts/resolve-ticket.ts into a pnpm-style
// node_modules layout, as app.test.ts does, and runs it for real with node and amaro.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { liveResolver, next } from './next.js'
import { lookupTicket } from './ticket-lookup.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const amaro = join(dirname(dirname(kit)), 'packages', 'ai', 'node_modules', 'amaro')
const hasAmaro = existsSync(amaro)
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const VERSION = '0.9.0'

type Fake = { stdout: string[]; stderr?: string; exit?: number }

/** The resolve script source: prints the given lines on stdout, an optional stderr line, and exits with the code. */
const resolveScript = ({ stdout, stderr, exit = 0 }: Fake): string =>
  [
    `process.stdout.write(${JSON.stringify(stdout.map((line) => `${line}\n`).join(''))})`,
    stderr === undefined ? '' : `process.stderr.write(${JSON.stringify(`${stderr}\n`)})`,
    `process.exitCode = ${String(exit)}`,
    '',
  ].join('\n')

type Layout = { root: string; app: string; common: string }

/**
 * A project whose app owns node_modules with @aspiralabs/ai laid out as pnpm does (the package and its
 * dependencies side by side in the store, amaro beside them). `common` decides what the package's common folder
 * holds: a fake resolve script, a package without the script, or no @aspiralabs/ai at all.
 */
function layout(common: Fake | 'no script' | 'absent'): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-lookup-')))
  const app = join(root, 'apps', 'web')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'web', private: true, devDependencies: { '@aspiralabs/ai': VERSION } }))
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
  const store = join(app, 'node_modules', '.pnpm', `@aspiralabs+ai@${VERSION}`, 'node_modules')
  const aiDir = join(store, '@aspiralabs', 'ai')
  const commonDir = join(aiDir, 'common')
  if (common !== 'absent') {
    mkdirSync(aiDir, { recursive: true })
    writeFileSync(join(aiDir, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: VERSION, type: 'module' }))
    mkdirSync(join(app, 'node_modules', '@aspiralabs'), { recursive: true })
    symlinkSync(aiDir, join(app, 'node_modules', '@aspiralabs', 'ai'))
    if (hasAmaro) symlinkSync(realpathSync(amaro), join(store, 'amaro'))
    mkdirSync(commonDir, { recursive: true })
    if (common !== 'no script') {
      mkdirSync(join(commonDir, 'scripts'), { recursive: true })
      writeFileSync(join(commonDir, 'scripts', 'resolve-ticket.ts'), resolveScript(common))
    }
  }
  return { root, app, common: join(app, 'node_modules', '@aspiralabs', 'ai', 'common') }
}

const lookup = ({ root, app }: Layout, ref = 'KIT-13') => lookupTicket(BOARD, ref, root, app)

const CARD = ['id=KIT-13', 'title=Kit QoL', 'url=https://www.notion.so/kit-13', 'status=In Progress: Plan']

describe('lookupTicket: the ticket the resolve script prints', () => {
  it.skipIf(!hasAmaro)('carries the card\'s type and working-folder name', () => {
    const result = lookup(layout({ stdout: [...CARD, 'type=Feature', 'folder=kit-13-kit-qol'] }))
    expect(result).toEqual({ ticket: { id: 'KIT-13', title: 'Kit QoL', url: 'https://www.notion.so/kit-13', status: 'In Progress: Plan', type: 'Feature', folder: 'kit-13-kit-qol' } })
  })

  it.skipIf(!hasAmaro)('leaves type and folder undefined when an older resolve script does not print them', () => {
    const result = lookup(layout({ stdout: CARD }))
    const ticket = 'ticket' in result ? result.ticket : undefined
    expect(ticket?.id).toBe('KIT-13')
    expect(ticket?.type).toBeUndefined()
    expect(ticket?.folder).toBeUndefined()
  })

  it.skipIf(!hasAmaro)('keeps an empty type as the empty string', () => {
    const result = lookup(layout({ stdout: [...CARD, 'type=', 'folder=kit-13-kit-qol'] }))
    const ticket = 'ticket' in result ? result.ticket : undefined
    expect(ticket?.type).toBe('')
  })
})

describe('lookupTicket: why there is no ticket', () => {
  it.skipIf(!hasAmaro)('an unknown ID, with the resolver\'s stderr in the detail', () => {
    const result = lookup(layout({ stdout: ['error=unknown'], stderr: 'resolve-ticket: No ticket KIT-99 on the board', exit: 1 }), 'KIT-99')
    expect(result).toMatchObject({ reason: 'unknown ID', detail: expect.stringContaining('No ticket KIT-99 on the board') })
  })

  it.skipIf(!hasAmaro)('an unreachable board, caused by the board', () => {
    const result = lookup(layout({ stdout: ['error=unreachable'], stderr: 'resolve-ticket: fetch failed', exit: 1 }))
    expect(result).toMatchObject({ reason: 'board unreachable', cause: 'board' })
  })

  it.skipIf(!hasAmaro)('a failing resolver that prints no error line counts as an unreachable board', () => {
    const result = lookup(layout({ stdout: [], stderr: 'resolve-ticket: something broke', exit: 1 }))
    expect(result).toMatchObject({ reason: 'board unreachable', cause: 'board' })
  })

  it.skipIf(!hasAmaro)('a card with an empty Status', () => {
    const result = lookup(layout({ stdout: ['id=KIT-13', 'title=Kit QoL', 'url=https://www.notion.so/kit-13', 'status='] }))
    expect(result).toMatchObject({ reason: 'no Status on the card' })
  })

  it.skipIf(!hasAmaro)('output without an id is an unreachable board, quoting what was printed', () => {
    const result = lookup(layout({ stdout: ['hello=world'] }))
    expect(result).toMatchObject({ reason: 'board unreachable', detail: expect.stringContaining('hello=world') })
  })

  it('no @aspiralabs/ai installed is an unreachable board caused by the kit, naming the package and where it looked', () => {
    const project = layout('absent')
    const result = lookup(project)
    expect(result).toMatchObject({ reason: 'board unreachable', cause: 'kit', detail: expect.stringContaining('@aspiralabs/ai') })
    expect(result).toMatchObject({ detail: expect.stringContaining(project.app) })
  })

  it('@aspiralabs/ai without its resolve script names the script path', () => {
    const project = layout('no script')
    const result = lookup(project)
    expect(result).toMatchObject({ reason: 'board unreachable', cause: 'kit', detail: expect.stringContaining(join(project.common, 'scripts', 'resolve-ticket.ts')) })
  })
})

describe('kit next names the cause before "see the error above"', () => {
  /** Runs kit next with liveResolver writing to a captured stream; log lines and stream writes share one ordered list. */
  function run(project: Layout): { code: number; events: { kind: 'warn' | 'log'; text: string }[] } {
    const events: { kind: 'warn' | 'log'; text: string }[] = []
    const writer = {
      write: (chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        for (const line of text.split('\n').filter((l) => l !== '')) events.push({ kind: 'warn', text: line })
        return true
      },
    }
    const code = next(project.root, 'KIT-13', (line) => events.push({ kind: 'log', text: line }), (b, r, p, a) => liveResolver(b, r, p, a, writer))
    return { code, events }
  }

  const check = (project: Layout, names: string) => {
    const { code, events } = run(project)
    const warnings = events.filter((e) => e.kind === 'warn')
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.text.startsWith('kit next:')).toBe(true)
    expect(warnings[0]?.text).toContain(names)
    const cannot = events.findIndex((e) => e.kind === 'log' && e.text.startsWith('cannot resolve KIT-13: the board did not answer (see the error above'))
    expect(cannot).toBeGreaterThan(events.findIndex((e) => e.kind === 'warn'))
    expect(code).toBe(1)
  }

  it('when @aspiralabs/ai is not installed', () => {
    check(layout('absent'), '@aspiralabs/ai')
  })

  it.skipIf(!hasAmaro)('when the resolver answers without an id', () => {
    check(layout({ stdout: ['hello=world'] }), 'hello=world')
  })
})
