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
const FOLDERS = ['build-feature', 'code-analyzer', 'codebase-map', 'common', 'groomer', 'implementor', 'planner', 'pr-reviewer', 'spec-reviewer', 'spec-writer', 'visual-verify']

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

  it('has all thirteen skills and the three hooks on disk', () => {
    const skills = ['skills/aspira-cleanup', 'skills/aspira-map-codebase', 'skills/aspira-next', 'skills/aspira-upgrade', 'skills/aspira-worktree', ...['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'build-feature', 'visual-verify'].map((agent) => `${agent}/skill/aspira-${agent}`)]
    expect(skills).toHaveLength(13)
    for (const dir of skills) expect(existsSync(join(AI, dir, 'SKILL.md')), `${dir}/SKILL.md`).toBe(true)
    for (const hook of ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']) expect(existsSync(join(AI, 'hooks', hook)), hook).toBe(true)
  })

  it('depends on exactly the union of the moved packages and on no @aspiralabs package', () => {
    const names = Object.keys(ai().dependencies ?? {})
    expect([...names].sort()).toEqual(['@modelcontextprotocol/sdk', '@vercel/connect', 'ai', 'amaro', 'eve', 'typescript', 'undici', 'zod'])
    expect(names.filter((name) => name.startsWith('@aspiralabs/'))).toEqual([])
  })
})

describe('common/ and codebase-map/ never reach into the kit code (NOVA1.1, F2)', () => {
  it('no file under common/ or codebase-map/ imports the playbook export, dist or the package src/dist', () => {
    const specifier = /(?:from\s+|import\()['"]([^'"]+)['"]/g
    const reachesKit = (file: string): boolean =>
      [...readFileSync(file, 'utf8').matchAll(specifier)].some(([, spec = ""]) => {
        if (/^@aspiralabs\/ai\/(playbook|dist)/.test(spec)) return true
        if (!spec.startsWith('.')) return false
        const target = resolve(dirname(file), spec)
        return target.startsWith(join(AI, 'src')) || target.startsWith(join(AI, 'dist'))
      })
    const offenders = [...sourceFiles(join(AI, 'common', 'src')), ...sourceFiles(join(AI, 'common', 'scripts')), ...sourceFiles(join(AI, 'codebase-map', 'src')), ...sourceFiles(join(AI, 'codebase-map', 'scripts'))].filter(reachesKit)
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

  it.each(['AGENTS.md', 'packages/ai/skills/aspira-next/SKILL.md', 'packages/config/README.md'])('%s names @aspiralabs/ai and no retired package', (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8')
    expect(text).toContain('@aspiralabs/ai')
    expect(text).not.toMatch(RETIRED)
  })

  // The template carries no managed block since KIT-71 (the process pointers live in ~/.claude), so it need not name @aspiralabs/ai.
  it('packages/ai/templates/agent/AGENTS.md names no retired package', () => {
    expect(readFileSync(join(ROOT, 'packages/ai/templates/agent/AGENTS.md'), 'utf8')).not.toMatch(RETIRED)
  })
})

// KIT-69: the codebase map is a folder of @aspiralabs/ai, ported from cartographer (Apache-2.0).
describe('the codebase map ships with its notices and nothing it must not have (F21, F22, F28, F29)', () => {
  const CODEBASE_MAP = join(AI, 'codebase-map')
  /** Shipped source: codebase-map/src and codebase-map/scripts, without the suites and fixtures that pin what must be absent. */
  const shipped = (): string[] =>
    [...sourceFiles(join(CODEBASE_MAP, 'src')), ...sourceFiles(join(CODEBASE_MAP, 'scripts'))].filter((file) => !/\.test(-helper)?\.ts$/.test(file) && !file.includes(`${join(CODEBASE_MAP, 'src')}/fixtures`))

  it('T33: THIRD_PARTY_NOTICES ships with the Apache License 2.0 and the cartographer URL, and every adapted file it lists carries the header and a modified-by line', () => {
    expect(ai().files).toContain('THIRD_PARTY_NOTICES')
    const notices = readFileSync(join(AI, 'THIRD_PARTY_NOTICES'), 'utf8')
    expect(notices).toContain('Apache License')
    expect(notices).toContain('Version 2.0, January 2004')
    expect(notices).toContain('https://github.com/kingbootoshi/cartographer')
    const listed = [...new Set([...notices.matchAll(/codebase-map\/[\w./-]+\.(?:ts|mjs|js)/g)].map(([path = '']) => path))]
    expect(listed.length).toBeGreaterThan(0)
    for (const path of listed) {
      expect(existsSync(join(AI, path)), `${path} exists`).toBe(true)
      const head = readFileSync(join(AI, path), 'utf8').split('\n').slice(0, 25).join('\n')
      expect(head, `${path} Apache header`).toMatch(/Licensed under the Apache License, Version 2\.0/)
      expect(head, `${path} modified-by line`).toMatch(/Modified by Aspira Labs/)
    }
  })

  it('T34: no shipped codebase-map file names OpenRouter, writes a docs/ folder or edits CLAUDE.md', () => {
    const files = shipped()
    expect(files.length).toBeGreaterThan(0)
    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return /openrouter/i.test(text) || /CLAUDE\.md/.test(text) || /['"`]docs['"`/]/.test(text)
      })
      .map((file) => file.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('T35: ./codebase-map exports a module that defines brief, typescript is a runtime dependency and no codebase-map source imports the kit', () => {
    const entry = ai().exports?.['./codebase-map']
    const target = typeof entry === 'string' ? entry : (entry as { default?: string } | undefined)?.default
    expect(target, './codebase-map export').toMatch(/^\.\/codebase-map\/src\//)
    const file = join(AI, target ?? '')
    expect(existsSync(file)).toBe(true)
    expect(file).not.toMatch(/index\.ts$/)
    expect(readFileSync(file, 'utf8')).toMatch(/export\s+(?:async\s+)?function\s+brief\b|export\s+const\s+brief\b/)
    expect(Object.keys(ai().dependencies ?? {})).toContain('typescript')
    expect(existsSync(join(AI, 'skills', 'aspira-map-codebase', 'SKILL.md'))).toBe(true)
    const reachesKit = (spec: string, from: string): boolean => {
      if (/^@aspiralabs\/ai\/(playbook|dist)/.test(spec)) return true
      if (!spec.startsWith('.')) return false
      const resolved = resolve(dirname(from), spec)
      return resolved.startsWith(join(AI, 'src')) || resolved.startsWith(join(AI, 'dist'))
    }
    const offenders = shipped().filter((path) => [...readFileSync(path, 'utf8').matchAll(/(?:from\s+|import\()['"]([^'"]+)['"]/g)].some(([, spec = '']) => reachesKit(spec, path)))
    expect(offenders).toEqual([])
  })
})
