import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalOf, approvedTechnologies, approvedTechnologiesIn, dependenciesAdded, manifestAdditions, nativeMarkersIn, renderDependencies, type DependencyAdded } from './dependencies.ts'

const exec = promisify(execFile)
const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const manifest = (deps: Record<string, string> = {}, dev: Record<string, string> = {}) => JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev }, null, 2)

describe('manifestAdditions', () => {
  it('lists only the packages that are new in a manifest, with their app and scope', () => {
    const base = new Map([
      ['package.json', manifest({ zod: '4.0.0' })],
      ['apps/web/package.json', manifest({ next: '15.0.0' }, { vitest: '3.0.0' })],
    ])
    const head = new Map([
      ['package.json', manifest({ zod: '4.5.4', 'left-pad': '1.3.0' })],
      ['apps/web/package.json', manifest({ next: '15.0.0', '@tanstack/react-query': '5.0.0' }, { vitest: '3.0.0', msw: '2.0.0' })],
      ['apps/mobile/package.json', manifest({ 'expo-camera': '16.0.0' })],
    ])
    expect(manifestAdditions(base, head)).toEqual([
      { name: 'left-pad', version: '1.3.0', manifest: 'package.json', app: 'root', scope: 'runtime' },
      { name: 'expo-camera', version: '16.0.0', manifest: 'apps/mobile/package.json', app: 'apps/mobile', scope: 'runtime' },
      { name: '@tanstack/react-query', version: '5.0.0', manifest: 'apps/web/package.json', app: 'apps/web', scope: 'runtime' },
      { name: 'msw', version: '2.0.0', manifest: 'apps/web/package.json', app: 'apps/web', scope: 'dev' },
    ])
    // A version bump is not an addition; a removal is not either.
    expect(manifestAdditions(new Map([['package.json', manifest({ zod: '4.0.0', a: '1' })]]), new Map([['package.json', manifest({ zod: '4.5.4' })]]))).toEqual([])
  })
})

describe('nativeMarkersIn', () => {
  it('flags each of the markers that mean native code', () => {
    expect(nativeMarkersIn(['package.json', 'ios', 'src'])).toEqual(['ios/'])
    expect(nativeMarkersIn(['android', 'build.gradle'])).toEqual(['android/'])
    expect(nativeMarkersIn(['expo-module.config.json'])).toEqual(['expo-module.config.json'])
    expect(nativeMarkersIn(['react-native.config.js'])).toEqual(['react-native.config.js'])
    expect(nativeMarkersIn(['package.json', 'dist', 'README.md'])).toEqual([])
  })
})

describe('approvedTechnologies', () => {
  it('reads a pipe table and a Notion table with Name, Status and Use Instead columns', () => {
    const pipe = `# Approved Technologies\n\n| Name | Category | Status | Use Instead |\n| --- | --- | --- | --- |\n| Zod | Library | Adopt | |\n| MSW | Tooling | Trial | |\n| Moment | Library | Retired | date-fns |\n`
    expect(approvedTechnologies(pipe)).toEqual([
      { name: 'Zod', status: 'Adopt', useInstead: '' },
      { name: 'MSW', status: 'Trial', useInstead: '' },
      { name: 'Moment', status: 'Retired', useInstead: 'date-fns' },
    ])
    const html = `<table header-row="true">\n<tr><td>Name</td><td>Status</td></tr>\n<tr><td>React Query</td><td>Adopt</td></tr>\n<tr><td>Lodash</td><td>Hold</td></tr>\n</table>`
    expect(approvedTechnologies(html)).toEqual([
      { name: 'React Query', status: 'Adopt', useInstead: '' },
      { name: 'Lodash', status: 'Hold', useInstead: '' },
    ])
    expect(approvedTechnologies('No table here.')).toEqual([])
  })

  it('matches a package to an entry by name, ignoring case, scope and spacing', () => {
    const list = approvedTechnologies(`| Name | Status |\n| --- | --- |\n| Zod | Adopt |\n| React Query | Trial |\n| Moment | Retired |\n`)
    expect(approvalOf('zod', list)).toEqual({ approval: 'Adopt', approved: true, useInstead: '' })
    expect(approvalOf('@tanstack/react-query', list)).toEqual({ approval: 'Trial', approved: true, useInstead: '' })
    expect(approvalOf('moment', list)).toEqual({ approval: 'Retired', approved: false, useInstead: '' })
    expect(approvalOf('left-pad', list)).toEqual({ approval: 'not listed', approved: false, useInstead: '' })
  })

  it('finds the Approved Technologies page in a knowledge folder by its header title, and reports when it is absent', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-knowledge-')))
    temps.push(dir)
    await writeFile(join(dir, 'agent-instructions.md'), '<!-- Agent Instructions · https://app.notion.com/p/1 · fetched t -->\n\n| Name | Status |\n| --- | --- |\n| NotThis | Adopt |\n')
    expect(await approvedTechnologiesIn(dir)).toEqual({ found: false, entries: [] })
    await writeFile(join(dir, 'approved-technologies.md'), '<!-- Approved Technologies · https://app.notion.com/p/2 · fetched t -->\n\n| Name | Status |\n| --- | --- |\n| Zod | Adopt |\n')
    expect(await approvedTechnologiesIn(dir)).toEqual({ found: true, entries: [{ name: 'Zod', status: 'Adopt', useInstead: '' }] })
  })
})

describe('renderDependencies', () => {
  const added: DependencyAdded[] = [
    { name: 'expo-camera', version: '16.0.0', manifest: 'apps/mobile/package.json', app: 'apps/mobile', scope: 'runtime', native: true, nativeMarkers: ['ios/', 'android/'], approval: 'Adopt', approved: true, useInstead: '' },
    { name: 'left-pad', version: '1.3.0', manifest: 'package.json', app: 'root', scope: 'dev', native: false, nativeMarkers: [], approval: 'not listed', approved: false, useInstead: '' },
    { name: 'moment', version: '2.0.0', manifest: 'package.json', app: 'root', scope: 'runtime', native: false, nativeMarkers: [], approval: 'Retired', approved: false, useInstead: 'date-fns' },
  ]
  it('writes the section: one line per addition with both flags and the sentence each flag requires', () => {
    const text = renderDependencies({ added, lockfileOnly: ['apps/web/pnpm-lock.yaml'], approvedFound: true })
    expect(text).toMatch(/^## Dependencies added\n/)
    expect(text).toContain('`expo-camera` 16.0.0 (apps/mobile, runtime): native (ios/, android/); approval: Adopt.')
    expect(text).toContain('the mobile app needs a store build')
    expect(text).toContain('`left-pad` 1.3.0 (root, dev): not native; approval: not listed.')
    expect(text).toContain('a human must approve it (Agent Instructions, Approved Technologies)')
    expect(text).toContain('`moment` 2.0.0 (root, runtime): not native; approval: Retired (use date-fns).')
    expect(text).toContain('Lockfile changed without a manifest change: apps/web/pnpm-lock.yaml')
  })
  it('says None for a build with no additions, and says when the Approved Technologies page was not loaded', () => {
    expect(renderDependencies({ added: [], lockfileOnly: [], approvedFound: true })).toBe('## Dependencies added\n\nNone\n')
    expect(renderDependencies({ added: [added[1]!], lockfileOnly: [], approvedFound: false })).toContain('Approved Technologies is not in the loaded knowledge')
  })
})

describe('dependenciesAdded (git)', () => {
  it('diffs every manifest between the branch base and HEAD, flags native modules from the installed package and approval from the knowledge', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-deps-')))
    temps.push(dir)
    const repo = join(dir, 'repo')
    await exec('git', ['init', '-q', '-b', 'main', repo])
    const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
    await mkdir(join(repo, 'apps/web'), { recursive: true })
    await mkdir(join(repo, 'apps/mobile'), { recursive: true })
    await writeFile(join(repo, 'package.json'), manifest({ zod: '4.0.0' }))
    await writeFile(join(repo, 'apps/web/package.json'), manifest({ next: '15.0.0' }))
    await writeFile(join(repo, 'apps/web/pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(join(repo, 'apps/mobile/package.json'), manifest({ expo: '57.0.0' }))
    await writeFile(join(repo, 'apps/mobile/package-lock.json'), '{}\n')
    await git('add', '.')
    await git('commit', '-qm', 'base')
    const base = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('switch', '-q', '-c', 'feat/x')
    // Root: a dev addition. Web: lockfile-only change. Mobile: one native and one not-listed addition.
    await writeFile(join(repo, 'package.json'), manifest({ zod: '4.5.4' }, { 'left-pad': '1.3.0' }))
    await writeFile(join(repo, 'apps/web/pnpm-lock.yaml'), 'lockfileVersion: 9\nsomething: changed\n')
    await writeFile(join(repo, 'apps/mobile/package.json'), manifest({ expo: '57.0.0', 'expo-camera': '16.0.0', 'tiny-lib': '0.1.0' }))
    await writeFile(join(repo, 'apps/mobile/package-lock.json'), '{"changed": true}\n')
    await git('add', '.')
    await git('commit', '-qm', 'adds')
    // The installed packages: expo-camera carries native code, tiny-lib does not; left-pad is hoisted to the root.
    await mkdir(join(repo, 'apps/mobile/node_modules/expo-camera/ios'), { recursive: true })
    await writeFile(join(repo, 'apps/mobile/node_modules/expo-camera/expo-module.config.json'), '{}')
    await mkdir(join(repo, 'apps/mobile/node_modules/tiny-lib'), { recursive: true })
    await writeFile(join(repo, 'apps/mobile/node_modules/tiny-lib/index.js'), '')
    await mkdir(join(repo, 'node_modules/left-pad'), { recursive: true })
    const knowledge = join(dir, 'knowledge')
    await mkdir(knowledge)
    await writeFile(join(knowledge, 'approved-technologies.md'), '<!-- Approved Technologies · https://app.notion.com/p/2 · fetched t -->\n\n| Name | Status |\n| --- | --- |\n| Expo Camera | Adopt |\n| Zod | Adopt |\n')

    const result = await dependenciesAdded({ repo, base, knowledgeDir: knowledge })
    expect(result.approvedFound).toBe(true)
    expect(result.lockfileOnly).toEqual(['apps/web/pnpm-lock.yaml'])
    expect(result.added.map((d) => [d.name, d.app, d.scope, d.native, d.nativeMarkers, d.approval])).toEqual([
      ['left-pad', 'root', 'dev', false, [], 'not listed'],
      ['expo-camera', 'apps/mobile', 'runtime', true, ['ios/', 'expo-module.config.json'], 'Adopt'],
      ['tiny-lib', 'apps/mobile', 'runtime', false, [], 'not listed'],
    ])
    // A package that is not installed cannot be native-checked; it is reported, not guessed.
    expect(result.added.find((d) => d.name === 'left-pad')?.installed).toBe(true)
    await rm(join(repo, 'node_modules'), { recursive: true })
    expect((await dependenciesAdded({ repo, base, knowledgeDir: knowledge })).added.find((d) => d.name === 'left-pad')?.installed).toBe(false)
  })
})
