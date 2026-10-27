// The compiled kit's copy of the effective aspira.json reader (src/aspira.ts, KIT-68): src cannot import the
// common package, so it carries the same reader. These tests pin that it agrees with common's, and that
// codebaseMapsFolder still validates only its own key.
//
// Contract these tests pin for the implementation: src/aspira.ts exports `readEffectiveAspira(from)` and
// `validateClientKeys(file)` with the shapes common/src/lib/aspira-config.ts documents, plus
// `readEffectiveAspira(from).config` carrying `statusFlow`, `pullRequest` (both true when absent), `guidelines`,
// `workRoot`, `extend` and `repos` (absent when the file does not set them).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEffectiveAspira as readCommon, validateClientKeys as validateCommon } from '../common/src/lib/aspira-config.js'
import { codebaseMapsFolder, readEffectiveAspira, validateClientKeys } from './aspira.js'

const temp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `aspira-client-${name}-`)))

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  return dir
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'no refusal'
}

/** The fixtures of T14, T15 and T16 for the kit's reader and common's: a client root, a stray parent file, and refused configs. */
function fixtures(): { root: string; file: string; strayRoot: string; strayFile: string; own: string; refused: Array<{ file: string; key: string }> } {
  const root = temp('client')
  gitRepo(join(root, 'web'))
  gitRepo(join(root, 'api'))
  mkdirSync(join(root, 'web', 'src'), { recursive: true })
  const file = join(root, 'aspira.json')
  writeFileSync(file, JSON.stringify({ repos: { web: { path: 'web' } } }))
  const own = gitRepo(join(root, 'own'))
  writeFileSync(join(own, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board' }))

  const strayRoot = temp('stray')
  gitRepo(join(strayRoot, 'web'))
  gitRepo(join(strayRoot, 'other'))
  const strayFile = join(strayRoot, 'aspira.json')
  writeFileSync(strayFile, JSON.stringify({ repos: { web: { path: 'web' } } }))

  const refused: Array<{ file: string; key: string }> = []
  const make = (config: Record<string, unknown>, key: string): void => {
    const dir = temp('refused')
    gitRepo(join(dir, 'web'))
    writeFileSync(join(dir, 'aspira.json'), JSON.stringify({ repos: { web: { path: 'web' } }, ...config }))
    refused.push({ file: join(dir, 'aspira.json'), key })
  }
  make({ guidelines: '/etc/rules' }, 'guidelines')
  make({ workRoot: '../x' }, 'workRoot')
  make({ extend: { planner: ['web/x.md'] } }, 'extend')
  make({ repos: { web: { path: 'web' }, bad: { path: '../x' } } }, 'repos')
  make({ pullRequest: false }, 'statusFlow')
  const linked = temp('linked')
  gitRepo(join(linked, 'web'))
  symlinkSync(temp('outside'), join(linked, 'rules'))
  writeFileSync(join(linked, 'aspira.json'), JSON.stringify({ repos: { web: { path: 'web' } }, guidelines: 'rules' }))
  refused.push({ file: join(linked, 'aspira.json'), key: 'guidelines' })
  return { root, file, strayRoot, strayFile, own, refused }
}

describe('the compiled kit\'s effective reader agrees with common\'s', () => {
  it('T21 returns the same file, repo and refusals as common for the T14, T15 and T16 fixtures', () => {
    const f = fixtures()
    const pick = (read: typeof readEffectiveAspira | typeof readCommon, dir: string) => {
      const effective = read(dir)
      return [effective.file, effective.repo, effective.ignored]
    }
    const dirs = [f.root, join(f.root, 'web'), join(f.root, 'web', 'src'), f.own, join(f.strayRoot, 'other'), join(f.strayRoot, 'web')]
    expect(dirs.map((dir) => pick(readEffectiveAspira, dir))).toEqual(dirs.map((dir) => pick(readCommon, dir)))
    expect(pick(readEffectiveAspira, join(f.root, 'web'))).toEqual([f.file, 'web', undefined])
    expect(pick(readEffectiveAspira, join(f.strayRoot, 'other'))).toEqual([undefined, undefined, f.strayFile])
    for (const { file, key } of f.refused) {
      const ours = refusal(() => validateClientKeys(file))
      expect(ours, key).not.toBe('no refusal')
      expect([ours.includes(file), ours.includes(key)], key).toEqual([true, true])
      expect(ours, key).toBe(refusal(() => validateCommon(file)))
    }
  })
})

describe('codebaseMaps and the other config files', () => {
  it('T20 keeps codebaseMapsFolder as it is, and reads the new keys as absent for a BATTALION-shaped file and a product file', () => {
    const root = temp('battalion')
    const repo = gitRepo(join(root, 'repo'))
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ codebaseMaps: '.codebase-maps' }))
    const product = gitRepo(temp('product'))
    writeFileSync(join(product, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board', releases: 'https://www.notion.so/releases' }))

    expect(codebaseMapsFolder(repo, repo)).toBe(join(root, '.codebase-maps'))
    for (const dir of [repo, product]) {
      const { config } = readEffectiveAspira(dir)
      expect([config.statusFlow, config.pullRequest, config.guidelines, config.workRoot, config.extend, config.repos], dir).toEqual([true, true, undefined, undefined, undefined, undefined])
    }
  })
})
