// KIT-69 T1-T7 (F1, F8, F11-F15, F32): the map build at seam S1, the real scripts/cli.ts run through
// node + amaro strip-types against a fixture git repo made per test and removed afterwards, observed
// through exit codes, stdout and the files under the map root (see fixture.test-helper.ts for the
// contract these tests pin where the spec leaves a name open).

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAIN, SLOW, build, check, cleanup, count, edgesFrom, generated, git, graphRows, handNote, hashesOf, hasValue, inRepo, makeRepo, mapDir, notesCli, readManifest, snapshot, startCli } from './fixture.test-helper.ts'

afterAll(cleanup)

const walk = async (dir: string): Promise<Buffer[]> => {
  const files = await snapshot(dir)
  return Promise.all(Object.keys(files).map((path) => readFile(join(dir, path))))
}

describe('F1: kit map-codebase builds the map', () => {
  it('T1: writes manifest, graph, CODEBASE_MAP.md, schema/ and briefs/ (no exports/) and prints the counts', async () => {
    const repo = await makeRepo(CHAIN)
    const root = inRepo(repo)
    const run = await build(repo)
    const map = mapDir(root)
    const manifest = await readManifest(root)
    const commit = await git(repo, 'rev-parse', 'HEAD')
    const rootCommit = await git(repo, 'rev-list', '--max-parents=0', 'HEAD')
    const names = readdirSync(map)
    const text = JSON.stringify(manifest)
    expect({
      code: run.code,
      files: ['manifest.json', 'CODEBASE_MAP.md'].map((name) => existsSync(join(map, name))),
      graph: names.some((name) => /\.(db|sqlite3?)$/.test(name)),
      folders: ['schema', 'briefs'].map((name) => existsSync(join(map, name)) && statSync(join(map, name)).isDirectory()),
      exports: existsSync(join(map, 'exports')),
      manifest: { commit: text.includes(commit), rootCommit: text.includes(rootCommit), mainCheckout: text.includes(repo), scanner: Object.keys(manifest).some((key) => /scanner/i.test(key)), dirty: Object.keys(manifest).some((key) => /dirty/i.test(key)), paths: Object.keys(hashesOf(manifest)).sort() },
      stdout: { root: run.stdout.includes(root), commit: run.stdout.includes(commit.slice(0, 7)), files: count(run.stdout, 'file'), internal: count(run.stdout, 'internal'), external: count(run.stdout, 'external'), unresolved: count(run.stdout, 'unresolved'), parsed: count(run.stdout, 'parsed'), reused: count(run.stdout, 'reused'), removed: count(run.stdout, 'removed') },
    }).toEqual({
      code: 0,
      files: [true, true],
      graph: true,
      folders: [true, true],
      exports: false,
      manifest: { commit: true, rootCommit: true, mainCheckout: true, scanner: true, dirty: true, paths: ['package.json', 'src/a.ts', 'src/b.ts', 'src/c.ts'] },
      stdout: { root: true, commit: true, files: 4, internal: 2, external: 0, unresolved: 0, parsed: 4, reused: 0, removed: 0 },
    })
  }, SLOW)
})

describe('F1, F32: a build is atomic and its lock survives a dead process', () => {
  it('T2: a build killed part-way leaves map/ byte-identical, --check stale, and the next build takes over the lock', async () => {
    const repo = await makeRepo({ ...CHAIN, ...generated(600, 'gen/g') })
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    const before = await snapshot(mapDir(root))
    await writeFile(join(repo, 'src/c.ts'), 'export const c = 2\n')

    const second = startCli(['--repo', repo, '--map-root', root], repo)
    const temporary = (): boolean => readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name !== 'map' && entry.name !== 'notes')
    const deadline = Date.now() + 120_000
    while (!temporary() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
    const sawTemporary = temporary()
    second.child.kill('SIGKILL')
    await second.done

    const unchanged = await snapshot(mapDir(root))
    const stale = await check(repo)
    const retry = await build(repo)
    const fresh = await check(repo)
    expect({ sawTemporary, unchanged: JSON.stringify(unchanged) === JSON.stringify(before), stale: stale.code, staleSays: /stale/i.test(stale.out), retry: retry.code, fresh: fresh.code }).toEqual({ sawTemporary: true, unchanged: true, stale: 1, staleSays: true, retry: 0, fresh: 0 })
  }, SLOW)
})

describe('F8, F13: what the scan reads and what the map records', () => {
  it('T3: tracked and untracked files in, ignored files, .env* and symlinks out, env names with their readers, no secret value', async () => {
    const repo = await makeRepo(
      {
        '.gitignore': 'ignored.ts\n',
        'package.json': JSON.stringify({ name: 'fx' }),
        'src/a.ts': 'export const key = process.env.API_KEY\n',
        'src/b.ts': "export const url = process.env['DB_URL']\n",
        'src/c.ts': 'export const host = import.meta.env.VITE_HOST\n',
        '.env': 'API_KEY=sk-fixture-value-123\n',
      },
      { symlinks: { 'src/link.ts': 'a.ts' }, untracked: { 'untracked.ts': 'export const u = 1\n', 'ignored.ts': 'export const i = 1\n', '.env.local': 'API_KEY=sk-fixture-value-123\n' } },
    )
    const root = inRepo(repo)
    const run = await build(repo)
    const rows = graphRows(root)
    const present = (path: string): boolean => rows.some((row) => hasValue(row, path))
    const reads = (name: string, file: string): boolean => rows.some((row) => hasValue(row, name) && hasValue(row, file))
    const everything = [...(await walk(root))]
    expect({
      code: run.code,
      nodes: Object.fromEntries(['src/a.ts', 'untracked.ts', 'ignored.ts', '.env', '.env.local', 'src/link.ts'].map((path) => [path, present(path)])),
      env: { API_KEY: reads('API_KEY', 'src/a.ts'), DB_URL: reads('DB_URL', 'src/b.ts'), VITE_HOST: reads('VITE_HOST', 'src/c.ts') },
      leaked: everything.some((bytes) => bytes.includes('sk-fixture-value-123')),
    }).toEqual({
      code: 0,
      nodes: { 'src/a.ts': true, 'untracked.ts': true, 'ignored.ts': false, '.env': false, '.env.local': false, 'src/link.ts': false },
      env: { API_KEY: true, DB_URL: true, VITE_HOST: true },
      leaked: false,
    })
  }, SLOW)
})

describe('F11, F12: surface and package of every file', () => {
  it('T4: each fixture file gets its step 8 surface and nearest package; .md, .css and .json carry no import edges', async () => {
    const repo = await makeRepo({
      'package.json': JSON.stringify({ name: 'root-pkg' }),
      'packages/shared/package.json': JSON.stringify({ name: '@fx/shared' }),
      'packages/shared/lib/util.ts': 'export const u = 1\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'db/migrations/001.sql': 'select 1;\n',
      'infra/main.tf': 'resource "x" "y" {}\n',
      'docs/guide.md': "```ts\nimport { core } from '../src/core.ts'\n```\n",
      'src/generated/api.ts': 'export const api = 1\n',
      'src/__tests__/a.test.ts': "import { core } from '../core.ts'\n",
      'scripts/run.ts': 'export const run = 1\n',
      'src/components/Button.tsx': 'export const Button = () => null\n',
      'src/api/handler.ts': 'export const handler = 1\n',
      'src/core.ts': 'export const core = 1\n',
      'styles.css': "@import './other.css';\n",
      'data.json': '{ "import": "./src/core.ts" }\n',
    })
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    const rows = graphRows(root)
    const surfaces = ['ci', 'database', 'iac', 'docs', 'generated', 'tests', 'scripts', 'frontend', 'backend', 'shared', 'source']
    const surfaceOf = (path: string): string[] => surfaces.filter((surface) => rows.some((row) => hasValue(row, path) && row.values.includes(surface)))
    const expected: Record<string, string> = {
      '.github/workflows/ci.yml': 'ci',
      'db/migrations/001.sql': 'database',
      'infra/main.tf': 'iac',
      'docs/guide.md': 'docs',
      'src/generated/api.ts': 'generated',
      'src/__tests__/a.test.ts': 'tests',
      'scripts/run.ts': 'scripts',
      'src/components/Button.tsx': 'frontend',
      'src/api/handler.ts': 'backend',
      'packages/shared/lib/util.ts': 'shared',
      'src/core.ts': 'source',
      'styles.css': 'frontend',
      'data.json': 'source',
    }
    const packageOf = (path: string, name: string, dir: string): boolean => rows.some((row) => hasValue(row, path) && (row.values.includes(name) || row.values.includes(dir)))
    expect({
      surfaces: Object.fromEntries(Object.keys(expected).map((path) => [path, surfaceOf(path)])),
      shared: packageOf('packages/shared/lib/util.ts', '@fx/shared', 'packages/shared'),
      root: packageOf('src/core.ts', 'root-pkg', '.'),
      noEdges: ['docs/guide.md', 'styles.css', 'data.json'].map((path) => edgesFrom(rows, path).length),
    }).toEqual({
      surfaces: Object.fromEntries(Object.entries(expected).map(([path, surface]) => [path, [surface]])),
      shared: true,
      root: true,
      noEdges: [0, 0, 0],
    })
  }, SLOW)
})

describe('F14: a rebuild parses only what changed', () => {
  it('T5: no change parses 0 and keeps every hash; one edit parses 1 and changes that file’s hash and edges alone', async () => {
    const repo = await makeRepo({ ...CHAIN, 'src/d.ts': 'export const d = 4\n' })
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)
    const hashes = hashesOf(await readManifest(root))
    const edges = (path: string): string => JSON.stringify(edgesFrom(graphRows(root), path))
    const first = await build(repo)
    const afterNoChange = hashesOf(await readManifest(root))
    const aEdges = edges('src/a.ts')
    const bEdges = edges('src/b.ts')

    await writeFile(join(repo, 'src/b.ts'), "import { d } from './d.ts'\nexport const b = d + 1\n")
    const second = await build(repo)
    const afterEdit = hashesOf(await readManifest(root))
    expect({
      noChange: { parsed: count(first.stdout, 'parsed'), same: afterNoChange },
      edit: { parsed: count(second.stdout, 'parsed'), changed: Object.keys(afterEdit).filter((path) => afterEdit[path] !== hashes[path]), aSame: edges('src/a.ts') === aEdges, bChanged: edges('src/b.ts') !== bEdges },
    }).toEqual({ noChange: { parsed: 0, same: hashes }, edit: { parsed: 1, changed: ['src/b.ts'], aSame: true, bChanged: true } })
  }, SLOW)
})

describe('F15: --check says fresh, stale or missing', () => {
  it('T6: missing before a build, fresh after, stale after every kind of change, still fresh after note writes', async () => {
    const repo = await makeRepo(CHAIN)
    const root = inRepo(repo)
    const missing = await check(repo)
    expect({ code: missing.code, says: /missing/i.test(missing.out) }).toEqual({ code: 1, says: true })

    const outcomes: Record<string, unknown> = {}
    const fresh = async (label: string): Promise<void> => {
      expect((await build(repo)).code).toBe(0)
      const run = await check(repo)
      outcomes[`${label} before`] = { code: run.code, says: /fresh/i.test(run.out) }
    }
    const stale = async (label: string, names: string[]): Promise<void> => {
      const run = await check(repo)
      outcomes[label] = { code: run.code, says: /stale/i.test(run.out), names: names.every((name) => run.out.includes(name)) }
    }

    await fresh('edit')
    await writeFile(join(repo, 'src/a.ts'), "import { b } from './b.ts'\nexport const a = b + 2\n")
    await stale('edit', ['src/a.ts'])
    await fresh('add')
    await writeFile(join(repo, 'src/new.ts'), 'export const n = 1\n')
    await stale('add', ['src/new.ts'])
    await fresh('delete')
    await unlink(join(repo, 'src/new.ts'))
    await stale('delete', ['src/new.ts'])
    await fresh('commit')
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'second')
    await stale('commit', [])
    await fresh('scanner')
    const manifest = await readManifest(root)
    const scannerKey = Object.keys(manifest).find((key) => /scanner/i.test(key)) ?? 'scannerVersion'
    await writeFile(join(mapDir(root), 'manifest.json'), JSON.stringify({ ...manifest, [scannerKey]: 'not-this-scanner' }))
    await stale('scanner', [])

    await fresh('notes')
    await handNote(repo, root, { id: 'hand-note-1', status: 'candidate', text: 'a hand-written note', paths: ['src/a.ts'] })
    const written = await check(repo)
    const accepted = await notesCli(repo, root, 'accept', 'hand-note-1')
    const afterAccept = await check(repo)
    const retired = await notesCli(repo, root, 'retire', 'hand-note-1')
    const afterRetire = await check(repo)
    outcomes.notes = { written: written.code, accept: accepted.code, afterAccept: afterAccept.code, retire: retired.code, afterRetire: afterRetire.code, says: /fresh/i.test(afterRetire.out) }

    const ok = { code: 0, says: true }
    const bad = { code: 1, says: true, names: true }
    expect(outcomes).toEqual({
      'edit before': ok,
      edit: bad,
      'add before': ok,
      add: bad,
      'delete before': ok,
      delete: bad,
      'commit before': ok,
      commit: bad,
      'scanner before': ok,
      scanner: bad,
      'notes before': ok,
      notes: { written: 0, accept: 0, afterAccept: 0, retire: 0, afterRetire: 0, says: true },
    })
  }, SLOW)
})

describe('F32: two builds at once', () => {
  it('T7: both exit 0, or one says a build is running; --check afterwards is fresh', async () => {
    const repo = await makeRepo({ ...CHAIN, ...generated(300, 'gen/g') })
    const [one, two] = await Promise.all([build(repo), build(repo)])
    const allowed = (run: { code: number; out: string }): boolean => run.code === 0 || /build is running/i.test(run.out)
    const afterwards = await check(repo)
    expect({ one: allowed(one), two: allowed(two), someBuilt: one.code === 0 || two.code === 0, check: afterwards.code }).toEqual({ one: true, two: true, someBuilt: true, check: 0 })
  }, SLOW)
})
