import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SandboxSession } from 'eve/sandbox'
import { describe, expect, it } from 'vitest'
import type { Analyzer } from './analyzers.ts'
import { hostExecutor, sandboxExecutor } from './executor.ts'
import type { Fixer } from './loop.ts'
import { KnowledgeRequired } from './knowledge.ts'
import { prepareToolchain, repositoryInstructions, runStaticAnalysis } from './runner.ts'

const exec = promisify(execFile)
const REQUIRED_MD = '# Agent Instructions\n\nAGT-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-001 Verify.\n'
/** A REQUIRED.md snapshot outside any repository: every default run needs the guidelines. */
async function snapshot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-rules-')))
  await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
  return join(dir, 'REQUIRED.md')
}
const noFix: Fixer = async () => ({ edits: 0, editedFiles: [], rejected: [], unresolved: [] })

/** A fixture repo whose `lint` script fails while src/a.js still uses `var`. */
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-runner-')))
  await exec('git', ['init', '-q', dir])
  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, 'node_modules'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { lint: 'node lint.js' } }))
  await writeFile(join(dir, 'lint.js'), `const fs = require('node:fs'); const text = fs.readFileSync('src/a.js', 'utf8'); const line = text.split('\\n').findIndex((l) => l.includes('var ')); if (line >= 0) { console.log('src/a.js(' + (line + 1) + ',1): error TS9000: no var'); process.exit(1) }`)
  await writeFile(join(dir, 'src/a.js'), 'var x = 1\nmodule.exports = x\n')
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n')
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  return dir
}

describe('runStaticAnalysis (local)', () => {
  it('fixes in place, writes the five outputs and ignores the output folder once', async () => {
    const dir = await fixture()
    const fixer: Fixer = async ({ batch }) => {
      for (const file of batch.files) await writeFile(join(dir, file), (await readFile(join(dir, file), 'utf8')).replace('var ', 'const '))
      return { edits: batch.files.length, editedFiles: batch.files, rejected: [], unresolved: [] }
    }
    const result = await runStaticAnalysis({ source: dir, guidelines: await snapshot() }, { fixer })
    expect(result.status).toBe('clean')
    expect(result.initial).toBe(1)
    expect(result.remaining).toBe(0)
    expect(result.editedFiles).toEqual(['src/a.js'])
    expect(result.dir).toBe(join(dir, '.static-analysis'))
    expect((await readdir(result.dir)).sort()).toEqual(['calls.json', 'diagnostics.json', 'guidelines', 'report.md', 'rounds.json', 'usage.json'])
    expect(await readFile(join(result.dir, 'guidelines', 'REQUIRED.md'), 'utf8')).toBe(REQUIRED_MD)
    expect(await readFile(join(dir, 'src/a.js'), 'utf8')).toContain('const x')
    expect(await readFile(join(dir, '.static-analysis/report.md'), 'utf8')).toContain('Status: **clean**')
    const status = (await exec('git', ['-C', dir, 'status', '--porcelain'])).stdout.split('\n').filter(Boolean)
    expect(status).toEqual([' M .gitignore', ' M src/a.js'])
    await runStaticAnalysis({ source: dir, maxRounds: 1, guidelines: await snapshot() }, { fixer: noFix })
    expect((await readFile(join(dir, '.gitignore'), 'utf8')).match(/\.static-analysis\//g)).toHaveLength(1)
  })
  it('analyzes a subdirectory of a repository with no root package.json, writing its output there', async () => {
    const dir = await fixture()
    // Move the project into apps/web, the shape of a repo with several apps and no root manifest.
    await mkdir(join(dir, 'apps/web'), { recursive: true })
    for (const name of ['package.json', 'lint.js', 'src', 'node_modules']) await exec('mv', [join(dir, name), join(dir, 'apps/web', name)])
    await writeFile(join(dir, 'AGENTS.md'), 'Root rule: prefer const.\n')
    await mkdir(join(dir, 'apps/mobile'))
    await writeFile(join(dir, 'apps/mobile/package.json'), JSON.stringify({ name: 'mobile', scripts: { lint: 'exit 3' } }))
    const web = join(dir, 'apps/web')
    const seen: string[][] = []
    const fixer: Fixer = async ({ batch }) => {
      seen.push(batch.files)
      for (const file of batch.files) await writeFile(join(web, file), (await readFile(join(web, file), 'utf8')).replace('var ', 'const '))
      return { edits: batch.files.length, editedFiles: batch.files, rejected: [], unresolved: [] }
    }
    const result = await runStaticAnalysis({ source: web, guidelines: await snapshot() }, { fixer })
    expect(result).toMatchObject({ status: 'clean', label: web, dir: join(web, '.static-analysis'), initial: 1, remaining: 0, editedFiles: ['src/a.js'] })
    expect(seen).toEqual([['src/a.js']])
    expect(await readFile(join(web, 'src/a.js'), 'utf8')).toContain('const x')
    expect(await readFile(join(web, '.gitignore'), 'utf8')).toBe('.static-analysis/\n')
    const rounds = JSON.parse(await readFile(join(web, '.static-analysis/rounds.json'), 'utf8'))
    expect(rounds.detection.analyzers.map((a: { id: string }) => a.id)).toEqual(['script:lint'])
    // The fixer still gets the repository's root instructions, as it did when a subdirectory meant the whole repo.
    expect(await repositoryInstructions(hostExecutor(web), dir)).toContain('SOURCE AGENTS.md\nRoot rule: prefer const.')
    expect(await repositoryInstructions(hostExecutor(dir), dir)).toBe('SOURCE AGENTS.md\nRoot rule: prefer const.\n')
  })
  it('reports partial with the stop reason when nothing can be fixed', async () => {
    const dir = await fixture()
    const result = await runStaticAnalysis({ source: dir, maxRounds: 2, guidelines: await snapshot() }, { fixer: noFix })
    expect(result.status).toBe('partial')
    expect(result.reason).toContain('no progress')
    expect(result.remaining).toBe(1)
  })
})

/** In-memory stand-in for the eve sandbox: records commands and answers a scripted set. */
function fakeSandbox(state: { errors: boolean }) {
  const commands: string[] = []
  const files = new Map<string, string>([['/workspace/repo/src/a.js', 'var x = 1\n'], ['/workspace/repo/package.json', JSON.stringify({ scripts: { lint: 'node lint.js' } })]])
  const sandbox = {
    id: 'fake',
    async run({ command }: { command: string }) {
      commands.push(command)
      const inner = command.match(/bash -c '([\s\S]*)'$/)?.[1]?.replaceAll(`'\\''`, "'") ?? command
      const ok = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' })
      if (command.startsWith('set -e')) return ok()
      if (inner.startsWith('git ls-files')) return ok([...files.keys()].map((p) => p.replace('/workspace/repo/', '')).join('\0'))
      if (inner.startsWith('command -v')) return ok('/usr/bin/x')
      if (inner === 'npm run lint') return state.errors ? ok('src/a.js(1,1): error TS9000: no var', 1) : ok()
      if (inner.startsWith('git status --porcelain')) return ok(' M src/a.js')
      if (inner.includes('git rev-parse HEAD')) return ok('deadbeefcafe')
      if (inner.startsWith('git format-patch')) return ok('From deadbeef\nSubject: [PATCH] chore: fix static analysis findings\n')
      if (inner.startsWith('git push')) return ok('', 1)
      return ok()
    },
    async readTextFile({ path }: { path: string }) { const text = files.get(path); if (text === undefined) throw new Error('missing'); return text },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content) },
  } as unknown as SandboxSession
  return { sandbox, commands, files }
}

describe('runStaticAnalysis (remote)', () => {
  it('clones into the sandbox, commits on a branch, writes a patch and does not push without the flag', async () => {
    const state = { errors: true }
    const { sandbox, commands, files } = fakeSandbox(state)
    const out = await mkdtemp(join(tmpdir(), 'sa-remote-out-'))
    const fixer: Fixer = async ({ batch }) => { files.set('/workspace/repo/src/a.js', 'const x = 1\n'); state.errors = false; return { edits: 1, editedFiles: batch.files, rejected: [], unresolved: [] } }
    const result = await runStaticAnalysis({ source: 'aspiralabs/fixture', outputDir: out, guidelines: await snapshot() }, { getSandbox: async () => sandbox, fixer, now: () => new Date('2026-09-27T10:00:00Z') })
    expect(result.status).toBe('clean')
    expect(result.remote).toEqual({ branch: 'static-analysis/20260927-100000', commit: 'deadbeefcafe', pushed: false, pullRequest: null })
    expect(commands[0]).toContain("git clone --quiet --depth 50 'https://github.com/aspiralabs/fixture.git' '/workspace/repo'")
    expect(commands.some((c) => c.includes('npm install'))).toBe(true)
    expect(commands.some((c) => c.includes('git push'))).toBe(false)
    expect((await readdir(out)).sort()).toEqual(['calls.json', 'changes.patch', 'diagnostics.json', 'guidelines', 'report.md', 'rounds.json', 'usage.json'])
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('Branch: `static-analysis/20260927-100000` at deadbeefca; not pushed.')
  })
  it('refuses a remote repository without a sandbox', async () => {
    await expect(runStaticAnalysis({ source: 'aspiralabs/fixture', guidelines: await snapshot() }, { fixer: noFix })).rejects.toThrow('fetched code never runs on the host')
  })
})

describe('runStaticAnalysis, engineering guidelines', () => {
  const page = (id: string) => `https://www.notion.so/${id.replaceAll('-', '')}`
  const ROOT = '0123456789abcdef0123456789abcdef'
  const AGENT = '11111111111111111111111111111111'
  const VERIFY = '22222222222222222222222222222222'
  /** Notion's API as load-knowledge reads it: page titles and each page's markdown. */
  const notion = (calls: string[]) => async (url: string) => {
    calls.push(url)
    const id = url.match(/pages\/([0-9a-f-]+)/)?.[1]?.replaceAll('-', '') ?? ''
    const title = { [ROOT]: 'Engineering', [AGENT]: 'Agent Instructions', [VERIFY]: 'Review Verification' }[id] ?? 'Other'
    if (url.endsWith('/markdown')) {
      const markdown = id === ROOT ? `Index.\n<page url="${page(AGENT)}">Agent Instructions</page>\n<page url="${page(VERIFY)}">Review Verification</page>` : `${title} rule ${id.slice(0, 4)}.`
      return Response.json({ markdown, truncated: false })
    }
    return Response.json({ properties: { title: { type: 'title', title: [{ plain_text: title }] } } })
  }

  it('refuses to run without guidelines, before anything runs or is written', async () => {
    const dir = await fixture()
    const error = await runStaticAnalysis({ source: dir }, { fixer: noFix, env: {} }).then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(KnowledgeRequired)
    expect(String(error)).toContain('NOTION_TOKEN and KNOWLEDGE_PAGE not set')
    expect((await exec('git', ['-C', dir, 'status', '--porcelain'])).stdout).toBe('')
    await expect(runStaticAnalysis({ source: dir, guidelines: join(dir, 'missing.md') }, { fixer: noFix, env: {} })).rejects.toThrow('not a file')
  })

  it('loads them from Notion the way load-knowledge does, from the agent\'s env', async () => {
    const dir = await fixture()
    const calls: string[] = []
    const agent = await realpath(await mkdtemp(join(tmpdir(), 'sa-agent-')))
    await mkdir(join(agent, 'code-analyzer'))
    await writeFile(join(agent, '.env.local'), `NOTION_TOKEN=secret\nKNOWLEDGE_PAGE=https://www.notion.so/Engineering-${ROOT}\n`)
    const result = await runStaticAnalysis({ source: dir, maxRounds: 1 }, { fixer: noFix, env: {}, agentDir: join(agent, 'code-analyzer'), fetch: notion(calls) })
    const guidelines = join(result.dir, 'guidelines')
    expect((await readdir(guidelines)).sort()).toEqual(['INDEX.md', 'REQUIRED.md', 'agent-instructions.md', 'review-verification.md'])
    const required = await readFile(join(guidelines, 'REQUIRED.md'), 'utf8')
    expect(required).toContain('# Agent Instructions')
    expect(required).toContain('Agent Instructions rule 1111.')
    expect(await readFile(join(guidelines, 'INDEX.md'), 'utf8')).toContain('[Agent Instructions](agent-instructions.md)')
    const recorded = JSON.parse(await readFile(join(result.dir, 'rounds.json'), 'utf8')).knowledge
    expect(recorded.source).toBe('notion')
    expect([...recorded.files].sort()).toEqual(['INDEX.md', 'REQUIRED.md', 'agent-instructions.md', 'review-verification.md'])
    expect(JSON.stringify(recorded)).not.toContain('secret')
    expect(calls.some((url) => url.endsWith(`/markdown`))).toBe(true)
    // The walk's temp folder is gone; the output's guidelines/ is the record.
    await expect(stat(recorded.dir)).rejects.toThrow()
  })

  it('takes a --knowledge folder and refuses one without the required pages', async () => {
    const dir = await fixture()
    const rules = await realpath(await mkdtemp(join(tmpdir(), 'sa-knowledge-')))
    await writeFile(join(rules, 'REQUIRED.md'), '# Agent Instructions\n')
    await writeFile(join(rules, 'INDEX.md'), '# Engineering\n')
    await expect(runStaticAnalysis({ source: dir, knowledge: rules }, { fixer: noFix, env: {} })).rejects.toThrow('Review Verification')
    await writeFile(join(rules, 'REQUIRED.md'), REQUIRED_MD)
    const result = await runStaticAnalysis({ source: dir, knowledge: rules, maxRounds: 1 }, { fixer: noFix, env: {} })
    expect((await readdir(join(result.dir, 'guidelines'))).sort()).toEqual(['INDEX.md', 'REQUIRED.md'])
  })
})

describe('prepareToolchain', () => {
  const need = (id: string, requires: string | null, install: string[] = []): Analyzer => ({ id, tool: id, ecosystem: 'python', cwd: '', check: id, fix: null, parse: () => [], requires, install })
  it('drops missing tools on the host and keeps the rest', async () => {
    const dir = await fixture()
    const { ready, unavailable } = await prepareToolchain(hostExecutor(dir), [need('ruff', 'definitely-missing-tool-xyz', ['pip install x']), need('script:lint', null), need('node-check', 'node')])
    expect(ready.map((a) => a.id)).toEqual(['script:lint', 'node-check'])
    expect(unavailable).toEqual(['ruff (needs definitely-missing-tool-xyz)'])
  })
  it('installs missing tools in the sandbox once per binary', async () => {
    let present = false
    const commands: string[] = []
    const sandbox = { async run({ command }: { command: string }) { commands.push(command); if (command.includes('command -v')) return { exitCode: present ? 0 : 1, stdout: '', stderr: '' }; if (command.includes('pip3 install')) present = true; return { exitCode: 0, stdout: '', stderr: '' } } } as unknown as SandboxSession
    const { ready, unavailable } = await prepareToolchain(sandboxExecutor(sandbox), [need('ruff', 'ruff', ['pip3 install ruff']), need('ruff-format', 'ruff', ['pip3 install ruff'])])
    expect(ready.map((a) => a.id)).toEqual(['ruff', 'ruff-format'])
    expect(unavailable).toEqual([])
    expect(commands.filter((c) => c.includes('pip3 install'))).toHaveLength(1)
  })
})
