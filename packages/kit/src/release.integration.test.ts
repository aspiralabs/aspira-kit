// The release workflow's version step, dry-run on a fixture: the repo's changesets config over
// minimal copies of every workspace package, one changeset, `changeset version`. Every package in
// the fixed group ends on one version: ui, config, kit, the seven agent packages and @aspiralabs/agents.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PACKAGES = ['ui', 'config', 'kit', 'agents/common', 'agents/spec-writer', 'agents/spec-reviewer', 'agents/planner', 'agents/implementor', 'agents/code-analyzer', 'agents/pr-reviewer', 'agents/meta']

it('bumps all eleven published packages to one version from a single changeset', () => {
  const config = JSON.parse(readFileSync(join(repo, '.changeset', 'config.json'), 'utf8')) as { fixed: string[][]; ignore: string[] }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-release-')))
  mkdirSync(join(dir, '.changeset'))
  writeFileSync(join(dir, '.changeset', 'config.json'), JSON.stringify({ ...config, changelog: false }))
  writeFileSync(join(dir, '.changeset', 'fixture.md'), "---\n'@aspiralabs/kit': minor\n---\n\nA fixture change.\n")
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - packages/agents/*\n  - apps/*\n')
  // The docs site is the one workspace package the release ignores.
  mkdirSync(join(dir, 'apps', 'docs'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'docs', 'package.json'), JSON.stringify({ name: 'docs', version: '0.0.0', private: true }))
  const names: string[] = []
  const before: Record<string, string> = {}
  for (const path of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(repo, 'packages', path, 'package.json'), 'utf8')) as { name: string; version: string; dependencies?: Record<string, string> }
    names.push(manifest.name)
    before[manifest.name] = manifest.version
    mkdirSync(join(dir, 'packages', path), { recursive: true })
    writeFileSync(join(dir, 'packages', path, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {} }))
  }
  // The changesets CLI and its changelog plugin come from the kit's own install.
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
  execFileSync('git', ['init', '-q', dir])
  execFileSync('node', [join(repo, 'node_modules', '@changesets', 'cli', 'bin.js'), 'version'], { cwd: dir, stdio: 'pipe' })
  const after = Object.fromEntries(PACKAGES.map((path) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'packages', path, 'package.json'), 'utf8')) as { name: string; version: string }
    return [manifest.name, manifest.version]
  }))
  expect(Object.keys(after).sort()).toEqual([...names].sort())
  expect(config.fixed[0]?.slice().sort()).toEqual([...names].sort())
  expect(config.ignore).not.toEqual(expect.arrayContaining(names))
  const versions = new Set(Object.values(after))
  expect(versions.size).toBe(1)
  const [version] = [...versions]
  expect(version).not.toBe(before['@aspiralabs/kit'])
  // A minor bump of the highest version in the group, which every member takes.
  const [major, minor] = before['@aspiralabs/kit']!.split('.').map(Number)
  expect(version).toBe(`${major}.${minor! + 1}.0`)
})
