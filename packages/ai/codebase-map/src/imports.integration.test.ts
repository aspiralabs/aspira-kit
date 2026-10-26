// KIT-69 T8-T9 (F9, F10): import resolution at seam S1. A fixture monorepo is written to disk (root
// tsconfig with paths, a nested app with its own @/ mapping, an app that inherits it through extends,
// a workspace package whose exports point at dist/ with no node_modules link) and the edges the built
// map records are read back through brief --json (a target's impact paths are its importers) and the
// SQLite graph. Every target below is imported by exactly one file, so its impact is that file.

import { afterAll, describe, expect, it } from 'vitest'
import { SLOW, build, cleanup, count, edgesFrom, graphRows, hasValue, inRepo, makeRepo, packetOf, type Files } from './fixture.test-helper.ts'

afterAll(cleanup)

const FILES: Files = {
  '.gitignore': 'dist\nnode_modules\n',
  'package.json': JSON.stringify({ name: 'mono', private: true }),
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
  // the root app
  'src/lib/rootonly.ts': 'export const rootonly = 1\n',
  'src/lib/nested.ts': 'export const decoy = 1\n',
  'src/root-importer.ts': "import { rootonly } from '@/lib/rootonly'\nexport const r = rootonly\n",
  // the nested app: its own base, its own @/ mapping
  'apps/web/tsconfig.base.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
  'apps/web/tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'apps/web/package.json': JSON.stringify({ name: '@mono/web' }),
  'apps/web/src/lib/nested.ts': 'export const nested = 1\n',
  'apps/web/src/lib/inh.ts': 'export const inh = 1\n',
  'apps/web/src/nested-importer.ts': "import { nested } from '@/lib/nested'\nexport const n = nested\n",
  // an app that only extends the web app's config: the inherited alias still means apps/web/src
  'apps/admin/tsconfig.json': JSON.stringify({ extends: '../web/tsconfig.json' }),
  'apps/admin/package.json': JSON.stringify({ name: '@mono/admin' }),
  'apps/admin/src/inherited-importer.ts': "import { inh } from '@/lib/inh'\nexport const i = inh\n",
  // a workspace package with exports at dist/ (not tracked) and its source in src/
  'packages/ui/package.json': JSON.stringify({ name: '@mono/ui', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }, types: './dist/index.d.ts', main: './dist/index.js' }),
  'packages/ui/src/index.ts': 'export const ui = 1\n',
  'apps/web/src/ws-importer.ts': "import { ui } from '@mono/ui'\nexport const w = ui\n",
  // the relative and statement forms
  'apps/web/src/targets/rel.ts': 'export const rel = 1\n',
  'apps/web/src/rel-importer.ts': "import { rel } from './targets/rel'\nexport const a = rel\n",
  'apps/web/src/targets/types.ts': 'export type T = { x: number }\n',
  'apps/web/src/type-importer.ts': "import type { T } from './targets/types'\nexport type U = T\n",
  'apps/web/src/targets/star.ts': 'export const star = 1\n',
  'apps/web/src/reexport.ts': "export * from './targets/star'\n",
  'apps/web/src/targets/dyn.ts': 'export const dyn = 1\n',
  'apps/web/src/dyn-importer.ts': "export const load = async () => import('./targets/dyn')\n",
  'apps/web/src/targets/multi.ts': 'export const one = 1\nexport const two = 2\n',
  'apps/web/src/multi-importer.ts': "import {\n  one,\n  two,\n} from './targets/multi'\nexport const m = one + two\n",
}

describe('F9: every import form is an internal edge to the file the layout says', () => {
  it('T8: relative, @/ (root, nested, inherited), workspace, type, re-export, dynamic and multi-line imports resolve', async () => {
    // the dist declaration is built output: ignored, present on disk, never a node
    const repo = await makeRepo(FILES, {
      untracked: { 'packages/ui/dist/index.d.ts': 'export declare const ui = 1\n', 'packages/ui/dist/index.js': 'export const ui = 1\n' },
    })
    const root = inRepo(repo)
    expect((await build(repo)).code).toBe(0)

    const expected: Record<string, string[]> = {
      'apps/web/src/targets/rel.ts': ['apps/web/src/rel-importer.ts'],
      'src/lib/rootonly.ts': ['src/root-importer.ts'],
      'apps/web/src/lib/nested.ts': ['apps/web/src/nested-importer.ts'],
      'src/lib/nested.ts': [],
      'apps/web/src/lib/inh.ts': ['apps/admin/src/inherited-importer.ts'],
      'packages/ui/src/index.ts': ['apps/web/src/ws-importer.ts'],
      'apps/web/src/targets/types.ts': ['apps/web/src/type-importer.ts'],
      'apps/web/src/targets/star.ts': ['apps/web/src/reexport.ts'],
      'apps/web/src/targets/dyn.ts': ['apps/web/src/dyn-importer.ts'],
      'apps/web/src/targets/multi.ts': ['apps/web/src/multi-importer.ts'],
    }
    const impacts = Object.fromEntries(await Promise.all(Object.keys(expected).map(async (target) => [target, (await packetOf(repo, root, [target])).impact] as const)))
    expect(impacts).toEqual(expected)
  }, SLOW)
})

describe('F10: external and unresolved imports are told apart', () => {
  it('T9: left-pad is external with its package name, ./missing is unresolved with its specifier and not counted as external', async () => {
    const repo = await makeRepo(
      {
        '.gitignore': 'node_modules\n',
        'package.json': JSON.stringify({ name: 'fx' }),
        'src/main.ts': "import pad from 'left-pad'\nimport { gone } from './missing'\nexport const x = pad(String(gone), 3)\n",
      },
      { untracked: { 'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js', types: 'index.d.ts' }), 'node_modules/left-pad/index.js': 'module.exports = (s) => s\n', 'node_modules/left-pad/index.d.ts': 'declare const pad: (s: string, n: number) => string\nexport default pad\n' } },
    )
    const run = await build(repo)
    const rows = graphRows(inRepo(repo))
    const edges = edgesFrom(rows, 'src/main.ts')
    const of = (specifier: string) => edges.filter((row) => row.values.some((value) => value === specifier || value.endsWith(`:${specifier}`)))
    expect({
      code: run.code,
      counts: { internal: count(run.stdout, 'internal'), external: count(run.stdout, 'external'), unresolved: count(run.stdout, 'unresolved') },
      pad: of('left-pad').map((row) => row.values.filter((value) => ['internal', 'external', 'unresolved'].includes(value))),
      missing: of('./missing').map((row) => row.values.filter((value) => ['internal', 'external', 'unresolved'].includes(value))),
      padFile: rows.some((row) => hasValue(row, 'node_modules/left-pad/index.js')),
    }).toEqual({ code: 0, counts: { internal: 0, external: 1, unresolved: 1 }, pad: [['external']], missing: [['unresolved']], padFile: false })
  }, SLOW)
})
