// KIT-65: the kit is three packages (ui, config, ai). @aspiralabs/ai is one package whose folders
// hold what used to be the kit CLI and the agent packages. These tests pin that layout (T1, T2),
// the NOVA1.1 direction inside it (common/ never imports the kit's code, T3) and that no shipped
// file still names a retired package (T4).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const AI = join(ROOT, 'packages', 'ai')
const SKIP = new Set(['node_modules', 'dist', '.eve', '.output'])

type Manifest = { name: string; version: string; bin?: Record<string, string>; files?: string[]; exports?: Record<string, unknown>; dependencies?: Record<string, string> }

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const dirsIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => !SKIP.has(name) && statSync(join(dir, name)).isDirectory()) : [])

/** Every package.json directly under packages/ (the workspace packages). */
function manifests(): Manifest[] {
  return dirsIn(join(ROOT, 'packages'))
    .map((name) => join(ROOT, 'packages', name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => readJson<Manifest>(file))
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|mjs|js|sh)$/.test(name) ? [path] : []
  })
}

const ai = (): Manifest => readJson<Manifest>(join(AI, 'package.json'))
const AGENT_FOLDERS = ['code-analyzer', 'groomer', 'implementor', 'planner', 'pr-reviewer', 'spec-writer']
const FOLDERS = ['build-feature', 'code-analyzer', 'common', 'groomer', 'implementor', 'planner', 'pr-reviewer', 'spec-reviewer', 'spec-writer', 'visual-verify']

describe('the kit is three packages (F1)', () => {
  it('has exactly ui, config and ai under packages/, with no member package.json inside ai', () => {
    expect(manifests().map((manifest) => manifest.name).sort()).toEqual(['@aspiralabs/ai', '@aspiralabs/config', '@aspiralabs/ui'])
    expect(dirsIn(join(ROOT, 'packages')).sort()).toEqual(['ai', 'config', 'ui'])
    expect(dirsIn(AI).filter((name) => existsSync(join(AI, name, 'package.json')))).toEqual([])
    expect(existsSync(join(ROOT, 'packages', 'kit'))).toBe(false)
    expect(existsSync(join(ROOT, 'packages', 'agents'))).toBe(false)
  })

  it('fixes one version group of exactly the three packages and drops the packages/agents/* glob', () => {
    const config = readJson<{ fixed: string[][] }>(join(ROOT, '.changeset', 'config.json'))
    expect([...(config.fixed[0] ?? [])].sort()).toEqual(['@aspiralabs/ai', '@aspiralabs/config', '@aspiralabs/ui'])
    expect(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('packages/agents/*')
  })

  // Lockstep, never a literal version: the version PR bumps all three, and a pinned number fails there.
  it('keeps the three packages at one version', () => {
    expect(new Set(manifests().map((manifest) => manifest.version)).size).toBe(1)
  })
})

describe('@aspiralabs/ai holds the moved packages as folders (F2)', () => {
  it('has one folder per moved package, each eve agent with agent/ and its eve project marker', () => {
    expect(dirsIn(AI)).toEqual(expect.arrayContaining(FOLDERS))
    for (const name of AGENT_FOLDERS) {
      expect(existsSync(join(AI, name, 'agent')), `${name}/agent`).toBe(true)
      expect(existsSync(join(AI, name, 'vercel.json')), `${name}/vercel.json`).toBe(true)
    }
  })

  it('keeps the kit bin and playbook export and maps the moved library paths', () => {
    const manifest = ai()
    expect(manifest.bin).toEqual({ kit: './dist/cli.js' })
    expect(manifest.exports).toMatchObject({
      './playbook': { types: './dist/playbook.d.ts', default: './dist/playbook.js' },
      './package.json': './package.json',
      './common/lib/*.json': './common/src/lib/*.json',
      './common/lib/*': './common/src/lib/*.ts',
      './common/tools/*': './common/src/tools/*.ts',
      './spec-reviewer/lib/*': './spec-reviewer/agent/lib/*.ts',
      './pr-reviewer/models': './pr-reviewer/agent/lib/models.ts',
    })
  })

  it('publishes the kit folders and each agent folder that has agent, skill, scripts or src', () => {
    const files = ai().files ?? []
    expect(files).toEqual(expect.arrayContaining(['dist', 'templates', 'hooks', 'skills', 'README.md', 'common/src', 'common/scripts']))
    for (const name of FOLDERS.filter((folder) => folder !== 'common')) {
      for (const part of ['agent', 'skill', 'scripts', 'src']) {
        if (existsSync(join(AI, name, part))) expect(files, `${name}/${part}`).toContain(`${name}/${part}`)
      }
    }
    for (const name of ['build-feature', 'visual-verify']) expect(files).toContain(`${name}/skill`)
    expect(files).toContain('build-feature/src')
  })

  it('has all eleven skills and the three hooks on disk', () => {
    const skills = ['skills/aspira-cleanup', 'skills/aspira-next', 'skills/aspira-worktree', ...['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'build-feature', 'visual-verify'].map((agent) => `${agent}/skill/aspira-${agent}`)]
    expect(skills).toHaveLength(11)
    for (const dir of skills) expect(existsSync(join(AI, dir, 'SKILL.md')), `${dir}/SKILL.md`).toBe(true)
    for (const hook of ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']) expect(existsSync(join(AI, 'hooks', hook)), hook).toBe(true)
  })

  it('depends on exactly the union of the moved packages and on no @aspiralabs package', () => {
    const names = Object.keys(ai().dependencies ?? {})
    expect([...names].sort()).toEqual(['@modelcontextprotocol/sdk', '@vercel/connect', 'ai', 'amaro', 'eve', 'undici', 'zod'])
    expect(names.filter((name) => name.startsWith('@aspiralabs/'))).toEqual([])
  })
})

describe('common/ never reaches into the kit code (NOVA1.1, F2)', () => {
  it('no file under common/ imports the playbook export, dist or the package src/dist', () => {
    const specifier = /(?:from\s+|import\()['"]([^'"]+)['"]/g
    const reachesKit = (file: string): boolean =>
      [...readFileSync(file, 'utf8').matchAll(specifier)].some(([, spec = ""]) => {
        if (/^@aspiralabs\/ai\/(playbook|dist)/.test(spec)) return true
        if (!spec.startsWith('.')) return false
        const target = resolve(dirname(file), spec)
        return target.startsWith(join(AI, 'src')) || target.startsWith(join(AI, 'dist'))
      })
    const offenders = [...sourceFiles(join(AI, 'common', 'src')), ...sourceFiles(join(AI, 'common', 'scripts'))].filter(reachesKit)
    expect(offenders).toEqual([])
  })

  it.each(['playbook.json', 'progress-note-shapes.json'])('common/src/lib/%s exists, ships and is exported', (file) => {
    expect(existsSync(join(AI, 'common', 'src', 'lib', file))).toBe(true)
    expect(ai().files).toContain('common/src')
    expect(ai().exports?.['./common/lib/*.json']).toBe('./common/src/lib/*.json')
  })
})

describe('no shipped file names a retired package (F14)', () => {
  const RETIRED = /@aspiralabs\/(kit|agents|agent-common|groomer|spec-writer|spec-reviewer|planner|implementor|code-analyzer|pr-reviewer|build-feature|visual-verify)\b/
  const textFiles = (path: string): string[] => {
    if (!existsSync(path)) return []
    if (!statSync(path).isDirectory()) return [path]
    return readdirSync(path).flatMap((name) => {
      if (SKIP.has(name) || name === 'CHANGELOG.md' || /\.test(-helper)?\.ts$/.test(name)) return []
      return textFiles(join(path, name))
    })
  }

  it('matches nothing in the files the package ships or its README', () => {
    const shipped = [...(ai().files ?? []).map((entry) => join(AI, entry)), join(AI, 'README.md')].flatMap(textFiles)
    expect(shipped.length).toBeGreaterThan(0)
    const offenders = shipped.filter((file) => RETIRED.test(readFileSync(file, 'utf8'))).map((file) => file.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it.each(['AGENTS.md', 'packages/ai/templates/agent/AGENTS.md', 'packages/ai/skills/aspira-next/SKILL.md', 'packages/config/README.md'])('%s names @aspiralabs/ai and no retired package', (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8')
    expect(text).toContain('@aspiralabs/ai')
    expect(text).not.toMatch(RETIRED)
  })
})
