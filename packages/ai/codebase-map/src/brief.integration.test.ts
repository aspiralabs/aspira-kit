// KIT-69 T12-T17 (F16-F21): brief at the CLI seam (text and --json) and at the library seam (the brief
// function imported from the package export), on a fixture repo built per test. The packet's field
// names are pinned in fixture.test-helper.ts. Import chains are plain relative imports so a target's
// impact is exactly the files the fixture says import it.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAIN, SLOW, build, briefCli, cleanup, generated, git, handNote, inRepo, makeRepo, packetOf, type Files } from './fixture.test-helper.ts'

afterAll(cleanup)

const MONO: Files = {
  'package.json': JSON.stringify({ name: 'fx-root', scripts: { test: 'vitest run' } }),
  'packages/pkg-a/package.json': JSON.stringify({ name: '@fx/a', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
  'packages/pkg-a/src/a.ts': 'export const shared = 1\n',
  'packages/pkg-a/src/a.test.ts': "import { shared } from './a.ts'\nexport const t = shared\n",
  'packages/pkg-b/package.json': JSON.stringify({ name: '@fx/b' }),
  'packages/pkg-b/src/b.ts': "import { shared } from '../../pkg-a/src/a.ts'\nexport const b = shared\n",
  'src/url.ts': "export const API_URL = 'http://localhost'\n",
  'src/use.ts': "import { API_URL } from './url.ts'\nimport { shared } from '../packages/pkg-a/src/a.ts'\nexport const u = process.env.API_URL ?? API_URL ?? shared\n",
}
const A = 'packages/pkg-a/src/a.ts'
const A_IMPORTERS = ['packages/pkg-a/src/a.test.ts', 'packages/pkg-b/src/b.ts', 'src/use.ts']

async function mono(): Promise<{ repo: string; root: string }> {
  const repo = await makeRepo(MONO)
  const root = inRepo(repo)
  expect((await build(repo)).code).toBe(0)
  return { repo, root }
}

describe('F16: a brief for a path, a package, an env var, a symbol or a set of changed files', () => {
  it('T12: path, package, env and symbol targets give the packet’s sections; env wins over symbol unless --kind says otherwise', async () => {
    const { repo, root } = await mono()
    const [path, pkg, env, symbol] = await Promise.all([packetOf(repo, root, [A]), packetOf(repo, root, ['@fx/a']), packetOf(repo, root, ['API_URL']), packetOf(repo, root, ['API_URL'], ['--kind', 'symbol'])])
    const sections = ['readFirst', 'impact', 'tests', 'validation', 'notes', 'stale', 'omissions']
    expect({
      sections: sections.filter((key) => !(key in path)),
      path: { kind: path.kind, readFirst: path.readFirst, impact: path.impact, tests: path.tests, validation: path.validation.some((command) => /test/.test(command)), notes: path.notes, stale: path.stale },
      pkg: { kind: pkg.kind, readFirst: pkg.readFirst.includes(A), impact: pkg.impact.includes('packages/pkg-b/src/b.ts') },
      env: { kind: env.kind, also: env.alsoMatched, readsIt: env.readFirst.includes('src/use.ts') },
      symbol: { kind: symbol.kind, exportsIt: symbol.readFirst.includes('src/url.ts') },
    }).toEqual({
      sections: [],
      path: { kind: 'path', readFirst: [A], impact: A_IMPORTERS, tests: ['packages/pkg-a/src/a.test.ts'], validation: true, notes: [], stale: [] },
      pkg: { kind: 'package', readFirst: true, impact: true },
      env: { kind: 'env', also: ['symbol'], readsIt: true },
      symbol: { kind: 'symbol', exportsIt: true },
    })
  }, SLOW)

  it('T12: the text brief has every section, names env with symbol also matched, and --json is the same packet', async () => {
    const { repo, root } = await mono()
    const text = await briefCli(repo, root, [A])
    const env = await briefCli(repo, root, ['API_URL'])
    const json = await packetOf(repo, root, [A])
    expect({
      code: [text.code, env.code],
      sections: [/read[- ]first/i, /impact/i, /tests/i, /validation/i, /notes/i, /stale/i, /omi(ssions|tted)/i].map((pattern) => pattern.test(text.stdout)),
      paths: json.impact.every((path) => text.stdout.includes(path)),
      env: { named: /\benv\b/i.test(env.stdout), also: /also[^\n]*symbol/i.test(env.stdout) },
    }).toEqual({ code: [0, 0], sections: [true, true, true, true, true, true, true], paths: true, env: { named: true, also: true } })
  }, SLOW)

  it('T12: several paths and --changed give the de-duplicated union of their impacts', async () => {
    const { repo, root } = await mono()
    await writeFile(join(repo, '.git', 'info', 'exclude'), '.codebase-map/\n')
    const several = await packetOf(repo, root, [A, 'src/url.ts'])
    await git(repo, 'checkout', '-q', '-b', 'feat')
    await writeFile(join(repo, A), 'export const shared = 2\n')
    await git(repo, 'commit', '-q', '-am', 'change a')
    await writeFile(join(repo, 'src/url.ts'), "export const API_URL = 'http://elsewhere'\n")
    expect((await build(repo)).code).toBe(0)
    const changed = await packetOf(repo, root, [], ['--changed'])
    expect({ several: several.impact, changed: changed.impact, readFirst: [A, 'src/url.ts'].every((path) => changed.readFirst.includes(path)) }).toEqual({ several: A_IMPORTERS, changed: A_IMPORTERS, readFirst: true })
  }, SLOW)
})

describe('F17: impact is transitive', () => {
  it('T13: direct importers come first, then those reached through a re-export, each once', async () => {
    const repo = await makeRepo({
      'package.json': JSON.stringify({ name: 'fx' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] }, module: 'esnext', moduleResolution: 'bundler' } }),
      'lib/a.ts': 'export const a = 1\n',
      'b.ts': "import { a } from './lib/a'\nexport const b = a\n",
      'index.ts': "export * from './lib/a'\n",
      'c.ts': "import { a } from './index'\nexport const c = a\n",
      'd.ts': "import { a } from '@/lib/a'\nexport const d = a\n",
    })
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    expect((await packetOf(repo, root, ['lib/a.ts'])).impact).toEqual(['b.ts', 'd.ts', 'index.ts', 'c.ts'])
  }, SLOW)
})

describe('F18: every list is bounded and the cut is reported', () => {
  const lib = { 'package.json': JSON.stringify({ name: 'fx' }), 'lib/a.ts': 'export const a = 1\n' }
  const importing = (n: number) => `import { a } from '../lib/a.ts'\nexport const v${n} = a\n`
  const note = (id: string) => ({ id, text: `note ${id}`, paths: ['lib/a.ts'] })
  /** packages/pN, each with a package.json (the scripts given) and one source file. */
  const workspace = (count: number, scripts: (n: number) => Record<string, string>): Files =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => i + 1).flatMap((n) => [[`packages/p${n}/package.json`, JSON.stringify({ name: `@f/p${n}`, scripts: scripts(n) })], [`packages/p${n}/src/x.ts`, 'export const x = 1\n']]))
  const cases: { list: string; files: Files; target: string; limit: number; first?: string; notes?: boolean }[] = [
    { list: 'readFirst', files: { 'package.json': lib['package.json'], ...generated(16, 'rf/f') }, target: 'rf', limit: 15, first: 'rf/f016.ts' },
    { list: 'impact', files: { ...lib, ...generated(26, 'imp/i', importing) }, target: 'lib/a.ts', limit: 25, first: 'imp/i026.ts' },
    { list: 'tests', files: { ...lib, ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t/t${String(i + 1).padStart(3, '0')}.test.ts`, importing(i)])) }, target: 'lib/a.ts', limit: 20, first: 't/t021.test.ts' },
    { list: 'packages', files: { ...lib, ...workspace(11, () => ({})) }, target: 'packages', limit: 10 },
    { list: 'validation', files: { ...lib, ...workspace(5, (n) => (n < 5 ? { test: 't', typecheck: 'c', lint: 'l' } : ({ test: 't' } as Record<string, string>))) }, target: 'packages', limit: 12 },
    { list: 'notes', files: lib, target: 'lib/a.ts', limit: 10, notes: true },
  ]

  for (const { list, files, target, limit, first, notes } of cases) {
    it(`T14: ${list} is cut at ${limit} with 1 left out, and two runs print the same packet`, async () => {
      const repo = await makeRepo(files)
      const root = inRepo(repo)
      if (notes) for (let n = 1; n <= 11; n += 1) await handNote(repo, root, note(`n${String(n).padStart(2, '0')}`))
      expect((await build(repo)).code).toBe(0)
      const one = await briefCli(repo, root, [target], ['--json'])
      const two = await briefCli(repo, root, [target], ['--json'])
      const text = await briefCli(repo, root, [target])
      const packet = JSON.parse(one.stdout) as Record<string, unknown[] | Record<string, { count: number; first: string[] }>>
      const cut = packet.omissions as Record<string, { count: number; first: string[] }>
      expect({
        codes: [one.code, two.code, text.code],
        length: (packet[list] as unknown[]).length,
        omitted: cut[list]?.count,
        firstOmitted: first === undefined ? 'n/a' : cut[list]?.first[0],
        sameRuns: one.stdout === two.stdout,
        inText: first === undefined ? true : text.stdout.includes(first),
      }).toEqual({ codes: [0, 0, 0], length: limit, omitted: 1, firstOmitted: first ?? 'n/a', sameRuns: true, inText: true })
    }, SLOW)
  }
})

describe('F19: every brief says it is orientation only', () => {
  it('T15: the text and the JSON carry the line that the brief must be verified with source reads', async () => {
    const repo = await makeRepo(CHAIN)
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    const text = await briefCli(repo, root, ['src/a.ts'])
    const json = await packetOf(repo, root, ['src/a.ts'])
    const says = (value: string): boolean[] => [/orientation only/i, /verif\w*[^\n]*source/i].map((pattern) => pattern.test(value))
    expect({ text: says(text.stdout), json: says(json.orientation) }).toEqual({ text: [true, true], json: [true, true] })
  }, SLOW)
})

describe('F20: a brief refuses what it cannot stand behind', () => {
  it('T16: a missing or stale map and a target matching nothing exit non-zero with no packet', async () => {
    const repo = await makeRepo(CHAIN)
    const root = inRepo(repo)
    const packetShown = (stdout: string): boolean => /read[- ]first|impact/i.test(stdout)
    const missing = await briefCli(repo, root, ['src/a.ts'])
    expect((await build(repo)).code).toBe(0)
    await writeFile(join(repo, 'src/c.ts'), 'export const c = 3\n')
    const stale = await briefCli(repo, root, ['src/a.ts'])
    expect((await build(repo)).code).toBe(0)
    const none = await briefCli(repo, root, ['no-such-target-xyz'])
    expect({
      missing: { refused: missing.code !== 0, packet: packetShown(missing.stdout), says: missing.out.includes('kit map-codebase') },
      stale: { refused: stale.code !== 0, packet: packetShown(stale.stdout), says: stale.out.includes('kit map-codebase') },
      none: { refused: none.code !== 0, says: /no match/i.test(none.out), packet: packetShown(none.stdout) },
    }).toEqual({
      missing: { refused: true, packet: false, says: true },
      stale: { refused: true, packet: false, says: true },
      none: { refused: true, says: true, packet: false },
    })
  }, SLOW)
})

describe('F21: brief is a library function', () => {
  it('T17: brief() from @aspiralabs/ai/codebase-map deep-equals the CLI’s --json packet', async () => {
    const { repo, root } = await mono()
    const { brief } = (await import('@aspiralabs/ai/codebase-map')) as { brief: (options: { repo: string; mapRoot: string; target: string }) => unknown }
    const fromLibrary = await brief({ repo, mapRoot: root, target: A })
    expect(fromLibrary).toEqual(await packetOf(repo, root, [A]))
  }, SLOW)
})
