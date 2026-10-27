// The effective aspira.json reader (aspira-config.ts, KIT-68): one config per repo, found by walking up across
// the git root, used above a repo only when its `repos` map that repo, with per-repo keys replacing top-level ones
// and every path key confined to the aspira.json folder. Fixtures are temp folder layouts.
//
// Contract these tests pin for the implementation (all paths absolute, symlinks resolved):
//   readEffectiveAspira(from): { file?, root?, repo?, repoDir?, config, ignored? }
//     file     the aspira.json in use; absent when none applies
//     root     the folder holding `file`
//     repo     the `repos` key of the repo `from` lies in (or the only mapped repo when run at the client root)
//     repoDir  that repo's folder
//     config   the file's keys, with the repo entry's per-repo keys (app, gates, dev, database, webhooks, tunnel,
//              baseBranch) replacing the top-level ones; baseBranch defaults to 'main' for a mapped repo
//     ignored  the aspira.json found above a repo that does not map it (then `file` is absent)
//   validateClientKeys(file): void; throws an Error naming the file and the key
//   repoForAreas(file, areas): the folder of the one repo the card's Area tags map to (case-insensitive); throws otherwise
//   extendFilesFor(from, stage): the absolute files `extend[stage]` lists; throws naming the file and "extend" when one is missing
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extendFilesFor, readEffectiveAspira, repoForAreas, validateClientKeys } from './aspira-config.ts'

const temp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `aspira-config-${name}-`)))

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  return dir
}

/** A client root (not a git repository) holding `config` as aspira.json and a git repo per name in `repos`. */
function client(config: Record<string, unknown>, repos: string[] = ['web', 'api']): { root: string; file: string } {
  const root = temp('client')
  for (const name of repos) gitRepo(join(root, name))
  const file = join(root, 'aspira.json')
  writeFileSync(file, JSON.stringify(config))
  return { root, file }
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'no refusal'
}

describe('extend files', () => {
  it('T13 refuses an extend file that does not exist, naming the file and the extend key', () => {
    const { root, file } = client({ repos: { web: { path: 'web' } }, extend: { planner: ['rules/missing.md'] } })
    const message = refusal(() => extendFilesFor(join(root, 'web'), 'planner'))
    expect([message.includes('rules/missing.md'), message.includes('extend'), message.includes(file)]).toEqual([true, true, true])
  })
})

describe('which aspira.json a folder uses', () => {
  it('T14 resolves the client file with web as the repo from the client root, web/, web/src and a ticket worktree, and own/ its own file', () => {
    const { root, file } = client({ repos: { web: { path: 'web' } } })
    mkdirSync(join(root, 'web', 'src'), { recursive: true })
    mkdirSync(join(root, 'web', '.worktrees', 'FEATURE-X-1'), { recursive: true })
    const own = gitRepo(join(root, 'own'))
    writeFileSync(join(own, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board' }))
    const from = [root, join(root, 'web'), join(root, 'web', 'src'), join(root, 'web', '.worktrees', 'FEATURE-X-1')]
    const seen = from.map((dir) => {
      const effective = readEffectiveAspira(dir)
      return [effective.file, effective.repo]
    })
    expect(seen).toEqual(from.map(() => [file, 'web']))
    expect(readEffectiveAspira(own).file).toBe(join(own, 'aspira.json'))
  })

  it('T15 treats a repo the parent file does not map as having no aspira.json, and names the ignored file', () => {
    const { root, file } = client({ repos: { web: { path: 'web' } } }, ['web', 'other'])
    const effective = readEffectiveAspira(join(root, 'other'))
    expect([effective.file, effective.ignored]).toEqual([undefined, file])
  })
})

describe('client key confinement', () => {
  const insideWeb = 'web/inside'
  const cases: Array<[string, string, (value: string) => Record<string, unknown>, string[]]> = [
    ['guidelines', 'guidelines', (value) => ({ guidelines: value }), ['/etc/rules', '../x', insideWeb]],
    ['workRoot', 'workRoot', (value) => ({ workRoot: value }), ['/etc/work', '../x', insideWeb]],
    ['extend', 'extend', (value) => ({ extend: { planner: [value] } }), ['/etc/x.md', '../x.md', 'web/x.md']],
    ['repos', 'repos', (value) => ({ repos: { web: { path: 'web' }, bad: { path: value } } }), ['/etc/repo', '../x']],
  ]
  for (const [label, key, build, values] of cases) {
    for (const value of values) {
      it(`T16 refuses ${label} ${JSON.stringify(value)}, naming the aspira.json file and "${key}"`, () => {
        const { file } = client({ repos: { web: { path: 'web' } }, ...build(value) })
        const message = refusal(() => validateClientKeys(file))
        expect([message.includes(file), message.includes(key)]).toEqual([true, true])
      })
    }
  }

  it('T17 refuses a guidelines folder that links outside the client root, a guidelines file that links into a repo, and a workRoot with no target', () => {
    const outside = temp('outside')
    const linkedFolder = client({ repos: { web: { path: 'web' } }, guidelines: 'rules' })
    symlinkSync(outside, join(linkedFolder.root, 'rules'))
    writeFileSync(join(outside, 'REV.md'), '**REV-001 — MUST** rule\n')

    const linkedFile = client({ repos: { web: { path: 'web' } }, guidelines: 'rules' })
    mkdirSync(join(linkedFile.root, 'rules'))
    writeFileSync(join(linkedFile.root, 'web', 'readme.md'), '**REV-001 — MUST** rule\n')
    symlinkSync(join(linkedFile.root, 'web', 'readme.md'), join(linkedFile.root, 'rules', 'a.md'))

    const missing = client({ repos: { web: { path: 'web' } }, workRoot: 'not-there' })

    for (const [setup, key] of [[linkedFolder, 'guidelines'], [linkedFile, 'guidelines'], [missing, 'workRoot']] as const) {
      const message = refusal(() => validateClientKeys(setup.file))
      expect([key, message.includes(setup.file), message.includes(key)]).toEqual([key, true, true])
    }
  })

  it('T22 refuses pullRequest false with no statusFlow key, naming both keys', () => {
    const { file } = client({ repos: { web: { path: 'web' } }, pullRequest: false })
    const message = refusal(() => validateClientKeys(file))
    expect([message.includes('pullRequest'), message.includes('statusFlow')]).toEqual([true, true])
  })
})

describe('per-repo keys', () => {
  it('T18 gives a mapped repo its own app, gates and base branch, and a repo without them today\'s defaults', () => {
    const gates = [{ command: 'pnpm check' }]
    const { root } = client({
      app: 'apps/a',
      gates: [{ command: 'pnpm top' }],
      repos: { web: { path: 'web', app: 'apps/web', gates, baseBranch: 'develop' }, api: { path: 'api' } },
    })
    const web = readEffectiveAspira(join(root, 'web')).config
    const api = readEffectiveAspira(join(root, 'api')).config
    expect([web.app, web.gates, web.baseBranch]).toEqual(['apps/web', gates, 'develop'])
    expect([api.app, api.gates, api.baseBranch]).toEqual([undefined, undefined, 'main'])
  })
})

describe('repos by Area tag', () => {
  const mapped = { web: { path: 'web' }, Web2: { path: 'web' }, api: { path: 'api' } }

  it('T19 refuses no match and two repos, resolves tags that map to one folder, and refuses case-duplicate and comma keys', () => {
    const { root, file } = client({ repos: mapped })
    const none = refusal(() => repoForAreas(file, []))
    const docs = refusal(() => repoForAreas(file, ['Docs']))
    const two = refusal(() => repoForAreas(file, ['web', 'api']))
    expect(docs.includes('Docs') && docs.includes('web') && docs.includes('api')).toBe(true)
    expect(none).not.toBe('no refusal')
    expect(two.includes('web') && two.includes('api')).toBe(true)
    expect(repoForAreas(file, ['web', 'Web2'])).toBe(join(root, 'web'))
    expect(repoForAreas(file, ['WEB'])).toBe(join(root, 'web'))

    const duplicate = client({ repos: { Web: { path: 'web' }, web: { path: 'web' } } })
    const dupMessage = refusal(() => validateClientKeys(duplicate.file))
    expect(dupMessage.includes('Web') && dupMessage.includes('web') && dupMessage.includes(duplicate.file)).toBe(true)
    const comma = client({ repos: { 'a,b': { path: 'web' } } })
    expect(refusal(() => validateClientKeys(comma.file))).toContain('a,b')
  })
})

describe('client key values (review 1)', () => {
  it('AVA1.1 refuses a baseBranch that is not a plain branch name, top level or per repo', () => {
    for (const base of ['-x', 'main;id', 'a..b']) {
      const top = client({ repos: { web: { path: 'web' } }, baseBranch: base })
      expect(refusal(() => validateClientKeys(top.file))).toContain('baseBranch')
      const perRepo = client({ repos: { web: { path: 'web', baseBranch: base } } })
      expect(refusal(() => validateClientKeys(perRepo.file))).toContain('baseBranch')
    }
    const ok = client({ repos: { web: { path: 'web', baseBranch: 'release/2.0' } } })
    expect(refusal(() => validateClientKeys(ok.file))).toBe('no refusal')
  })

  it('DEX1.1 refuses an extend stage that no agent reads, naming the stage', () => {
    const { file } = client({ repos: { web: { path: 'web' } }, extend: { spec: [] } })
    const message = refusal(() => validateClientKeys(file))
    expect([message.includes('"spec"'), message.includes('spec-writer')]).toEqual([true, true])
  })
})
