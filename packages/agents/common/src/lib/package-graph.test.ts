// NOVA1.1, DEX2.1: the direction packages depend on each other. kit is the installer: agent-common
// (which every agent package depends on) never depends on it, nothing in agent-common imports it,
// and no package under packages/ is part of a dependency cycle. The data kit reads from agent-common
// (the Playbook table, the progress-note command shapes) ships as JSON in the published package and
// resolves through its `exports`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')
const COMMON = join(ROOT, 'packages', 'agents', 'common')

type Manifest = { name: string; files?: string[]; exports?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

/** Every package.json directly under packages/ and packages/agents/. */
function manifests(): Manifest[] {
  const dirs = [join(ROOT, 'packages'), join(ROOT, 'packages', 'agents')]
  return dirs
    .flatMap((dir) => readdirSync(dir).map((name) => join(dir, name, 'package.json')))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as Manifest)
}

const workspaceDeps = (manifest: Manifest, names: Set<string>): string[] =>
  [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {})).filter((name) => names.has(name))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|mjs|js|sh)$/.test(name) ? [path] : []
  })
}

describe('package dependency direction (NOVA1.1)', () => {
  it('@aspiralabs/agent-common does not depend on @aspiralabs/kit in any dependency field', () => {
    const common = JSON.parse(readFileSync(join(COMMON, 'package.json'), 'utf8')) as Manifest
    for (const deps of [common.dependencies, common.devDependencies, common.peerDependencies, common.optionalDependencies]) expect(Object.keys(deps ?? {})).not.toContain('@aspiralabs/kit')
  })

  it('no file in agent-common imports @aspiralabs/kit', () => {
    const offenders = [...sourceFiles(join(COMMON, 'src')), ...sourceFiles(join(COMMON, 'scripts'))].filter((file) => /from ['"]@aspiralabs\/kit[/'"]|import\(['"]@aspiralabs\/kit[/'"]/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no package under packages/ is part of a dependency cycle', () => {
    const all = manifests()
    const names = new Set(all.map((manifest) => manifest.name))
    const edges = new Map(all.map((manifest) => [manifest.name, workspaceDeps(manifest, names)]))
    const cycles: string[] = []
    const visit = (name: string, path: string[]) => {
      if (path.includes(name)) {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '))
        return
      }
      for (const next of edges.get(name) ?? []) visit(next, [...path, name])
    }
    for (const name of names) visit(name, [])
    expect(cycles).toEqual([])
  })
})

describe('the JSON kit reads from agent-common ships in the package (NOVA1.1, DEX2.1)', () => {
  const common = JSON.parse(readFileSync(join(COMMON, 'package.json'), 'utf8')) as Manifest

  it.each(['playbook.json', 'progress-note-shapes.json'])('src/lib/%s exists, is published (files) and resolves through exports', (file) => {
    expect(existsSync(join(COMMON, 'src', 'lib', file))).toBe(true)
    expect(common.files).toContain('src')
    expect(common.exports?.['./lib/*.json']).toBe('./src/lib/*.json')
  })
})
