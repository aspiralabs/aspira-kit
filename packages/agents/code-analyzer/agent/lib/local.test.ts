import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { batch as batches, type Batch } from './diagnostics.ts'
import { hostExecutor } from './executor.ts'
import { doneSchema, fileExcerpt, fixPrompt, knowledgeSection, systemPrompt } from './fixer.ts'
import { KnowledgeRequired, knowledgeConfig, runLocal, workDirFor, type LocalDeps, type LocalDone, type LocalInput, type LocalPending, type LocalResult } from './local.ts'
import { script } from './parsers.ts'
import { repositoryInstructions } from './runner.ts'

const exec = promisify(execFile)
const PACKAGE_DIR = join(import.meta.dirname, '..', '..')

// The folder the session builds from Notion before the first step, in load-knowledge's shape.
const REQUIRED_MD = '<!-- Required reading -->\n\n---\n\n# Agent Instructions\n\nAGT-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-001 Verify.\n'
async function seedKnowledge(dir: string, required = REQUIRED_MD) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), required)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [TypeScript](typescript.md)\n')
  await writeFile(join(dir, 'typescript.md'), '# TypeScript\n\nTS-002 No any.\n')
}

/** A copy of the agent with no env files, so the tests see load-knowledge's defaults, not this machine's config. */
async function agentCopy(edit?: (fixer: string) => string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-local-agent-')))
  await cp(join(PACKAGE_DIR, 'agent'), join(dir, 'agent'), { recursive: true })
  await symlink(join(PACKAGE_DIR, 'node_modules'), join(dir, 'node_modules'))
  if (edit) {
    const path = join(dir, 'agent', 'lib', 'fixer.ts')
    await writeFile(path, edit(await readFile(path, 'utf8')))
  }
  return dir
}

/** A repository shaped like a multi-app repo: no root package.json, the project in apps/web. */
async function monorepo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-local-')))
  const web = join(dir, 'apps', 'web')
  await mkdir(join(web, 'src'), { recursive: true })
  await mkdir(join(web, 'node_modules'))
  await exec('git', ['init', '-q', dir])
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n')
  await writeFile(join(dir, 'AGENTS.md'), 'Root rule: prefer const.\n')
  await writeFile(join(web, 'package.json'), JSON.stringify({ name: 'web', scripts: { lint: 'node lint.js' } }))
  await writeFile(
    join(web, 'lint.js'),
    `const fs = require('node:fs'); let bad = false
for (const file of ['src/a.js', 'src/b.js']) { if (!fs.existsSync(file)) continue; fs.readFileSync(file, 'utf8').split('\\n').forEach((l, i) => { if (l.includes('var ')) { bad = true; console.log(file + '(' + (i + 1) + ',1): error TS9000: no var') } }) }
process.exit(bad ? 1 : 0)\n`,
  )
  await writeFile(join(web, 'src', 'a.js'), 'var x = 1\nmodule.exports = x\n')
  await writeFile(join(web, 'src', 'b.js'), 'var y = 2\nmodule.exports = y\n')
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const knowledge = join(web, '.static-analysis', '.local', 'knowledge')
  return { dir, web, knowledge }
}

const pending = (result: LocalResult): LocalPending => {
  if (!result.pending) throw new Error(`expected a pending stage, got ${result.status}: ${result.reason}`)
  return result
}
const finished = (result: LocalResult): LocalDone => {
  if (result.pending) throw new Error(`expected a finished run, got stage ${result.stage}`)
  return result
}
const refusal = async (promise: Promise<unknown>): Promise<KnowledgeRequired> => {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  )
  if (!(error instanceof KnowledgeRequired)) throw new Error(`expected a KnowledgeRequired refusal, got ${String(error)}`)
  return error
}
const done = (unresolved: { file: string; line: number | null; reason: string }[] = []) => JSON.stringify({ summary: 'fixed', unresolved })
const fixVars = async (web: string, files: string[]) => {
  for (const file of files) await writeFile(join(web, file), (await readFile(join(web, file), 'utf8')).replace('var ', 'const '))
}

let agentDir = ''
beforeAll(async () => {
  agentDir = await agentCopy()
})
const deps = (): LocalDeps => ({ agentDir, env: {} })

describe('runLocal, engineering guidelines', () => {
  it('refuses to start without REQUIRED.md and INDEX.md, runs nothing and names the pages from the agent\'s config', async () => {
    const { web, knowledge } = await monorepo()
    const missing = await refusal(runLocal({ source: web }, deps()))
    expect(missing.message).toContain('REQUIRED.md')
    expect(missing.plan).toMatchObject({ stage: 'knowledge', dir: knowledge, page: null, required: ['Agent Instructions', 'Review Verification'], maxDepth: 3, maxPages: 80 })
    await expect(stat(join(workDirFor(join(web, '.static-analysis')), 'state.json'))).rejects.toThrow()

    await mkdir(knowledge, { recursive: true })
    await writeFile(join(knowledge, 'REQUIRED.md'), REQUIRED_MD)
    await writeFile(join(knowledge, 'INDEX.md'), '  \n')
    expect((await refusal(runLocal({ source: web }, deps()))).message).toContain('INDEX.md')
    await writeFile(join(knowledge, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(knowledge, 'REQUIRED.md'), '# Agent Instructions\n\nAGT-001\n')
    expect((await refusal(runLocal({ source: web }, deps()))).message).toContain('Review Verification')
    await writeFile(join(knowledge, 'REQUIRED.md'), REQUIRED_MD)
    expect(pending(await runLocal({ source: web }, deps())).stage).toBe('fix')
  })

  it('reads the page list from the agent\'s own load-knowledge configuration and env files, never the token', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-local-env-')))
    const agent = join(dir, 'code-analyzer')
    await mkdir(agent)
    const page = 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef'
    // The package scripts load ../.env.local (shared) and .env.development.local, as eve does.
    await writeFile(join(dir, '.env.local'), `AI_GATEWAY_API_KEY=x\nKNOWLEDGE_PAGE=${page}\nNOTION_TOKEN=secret\n`)
    expect(await knowledgeConfig(agent, {})).toMatchObject({ page, required: ['Agent Instructions', 'Review Verification'], maxDepth: 3, maxPages: 80 })
    await writeFile(join(agent, '.env.development.local'), 'KNOWLEDGE_REQUIRED="Agent Instructions, TypeScript Rules"\n')
    expect((await knowledgeConfig(agent, {})).required).toEqual(['Agent Instructions', 'TypeScript Rules'])
    expect((await knowledgeConfig(agent, { KNOWLEDGE_REQUIRED: 'Only This' })).required).toEqual(['Only This'])

    const { web, knowledge } = await monorepo()
    const error = await refusal(runLocal({ source: web }, { agentDir: agent, env: {} }))
    expect(error.plan).toMatchObject({ page, required: ['Agent Instructions', 'TypeScript Rules'] })
    expect(JSON.stringify(error.plan)).not.toContain('secret')
    await seedKnowledge(knowledge)
    expect((await refusal(runLocal({ source: web }, { agentDir: agent, env: {} }))).message).toContain('TypeScript Rules')
  })

  it('refuses a mid-run change to the guidelines and a different --guidelines folder', async () => {
    const { dir, web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    pending(await runLocal({ source: web }, deps()))
    await writeFile(join(knowledge, 'typescript.md'), '# TypeScript\n\nTS-002 Any is fine.\n')
    await expect(runLocal({ source: web }, deps())).rejects.toThrow('guidelines')

    const other = await monorepo()
    const rules = join(dir, 'rules')
    await seedKnowledge(rules)
    pending(await runLocal({ source: other.web, knowledge: rules }, deps()))
    // Later calls keep the folder the run started with.
    expect(pending(await runLocal({ source: other.web }, deps())).stage).toBe('fix')
    await seedKnowledge(join(dir, 'elsewhere'))
    await expect(runLocal({ source: other.web, knowledge: join(dir, 'elsewhere') }, deps())).rejects.toThrow('--knowledge')
    await expect(runLocal({ source: other.web, knowledge: rules, guidelines: join(rules, 'REQUIRED.md') }, deps())).rejects.toThrow('not both')
  })

  it('takes a REQUIRED.md snapshot with --guidelines FILE, as the other agents do', async () => {
    const { dir, web } = await monorepo()
    const file = join(dir, 'REQUIRED.md')
    await writeFile(file, '# Agent Instructions\n\nAGT-001\n')
    expect((await refusal(runLocal({ source: web, guidelines: file }, deps()))).message).toContain('Review Verification')
    await expect(stat(join(workDirFor(join(web, '.static-analysis')), 'state.json'))).rejects.toThrow()
    await writeFile(file, REQUIRED_MD)
    const first = pending(await runLocal({ source: web, guidelines: file }, deps()))
    const text = await readFile(first.tasks[0]!.prompt, 'utf8')
    expect(text).toContain(knowledgeSection({ path: null, requiredFile: file, required: REQUIRED_MD }))
    await fixVars(web, first.tasks[0]!.files)
    await writeFile(first.tasks[0]!.output, done())
    const result = finished(await runLocal({ source: web }, deps()))
    expect(result.status).toBe('clean')
    expect(await readFile(join(web, '.static-analysis', 'guidelines', 'REQUIRED.md'), 'utf8')).toBe(REQUIRED_MD)
  })
})

describe('runLocal, the fix loop', () => {
  it('writes each batch\'s exact fixer prompt, with the guidelines and the repository root\'s instructions', async () => {
    const { dir, web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const first = pending(await runLocal({ source: web }, deps()))
    const work = workDirFor(join(web, '.static-analysis'))
    expect(first).toMatchObject({ stage: 'fix', round: 1, maxRounds: 6, parallel: 3, workDir: work, root: web, orchestrator: join(agentDir, 'agent', 'instructions.md') })
    expect(first.tasks).toHaveLength(1)
    const task = first.tasks[0]!
    expect(task).toMatchObject({ id: 'round-1-batch-1', files: ['src/a.js', 'src/b.js'], diagnostics: 2, output: join(work, 'outputs', 'round-1-batch-1.json') })
    const executor = hostExecutor(web)
    // What the analyzer reports, parsed by the agent's own parser for a lint script.
    const lint = await exec('node', ['lint.js'], { cwd: web }).then(
      (r) => r.stdout,
      (error: { stdout: string }) => error.stdout,
    )
    const batch: Batch = batches(script('lint')(lint, '', { cwd: '', root: web }) ?? [])[0]!
    expect(batch.files).toEqual(['src/a.js', 'src/b.js'])
    const excerpts = await Promise.all(batch.files.map((file) => fileExcerpt(executor, file, batch.diagnostics.filter((d) => d.file === file))))
    const knowledgeRef = { path: knowledge, requiredFile: join(knowledge, 'REQUIRED.md'), required: REQUIRED_MD }
    const expected = fixPrompt({ instructions: await repositoryInstructions(executor, dir), batch, excerpts, knowledge: knowledgeRef })
    const text = await readFile(task.prompt, 'utf8')
    // The fix model's system prompt and task, byte for byte, as fixer.ts builds them on this call.
    expect(text).toContain(`\n## System\n\n${systemPrompt}\n\n## Task\n\n${expected}\n\n## Output schema\n`)
    expect(text).toContain(knowledgeSection(knowledgeRef))
    expect(text).toContain('Root rule: prefer const.')
    expect(text).toContain(task.output)
  })

  it('runs rounds until clean and exports the agent\'s layout, recording the rules it ran under', async () => {
    const { dir, web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const first = pending(await runLocal({ source: web }, deps()))
    await fixVars(web, first.tasks[0]!.files)
    await writeFile(first.tasks[0]!.output, done())
    const result = finished(await runLocal({ source: web }, deps()))
    const out = join(web, '.static-analysis')
    expect(result).toMatchObject({ status: 'clean', reason: 'analyzers clean', dir: out, root: web, rounds: 2, initial: 2, remaining: 0, editedFiles: ['src/a.js', 'src/b.js'], rejected: [] })
    expect((await readdir(out)).sort()).toEqual(['calls.json', 'diagnostics.json', 'guidelines', 'report.md', 'rounds.json', 'usage.json'])
    expect(await readFile(join(out, 'guidelines', 'REQUIRED.md'), 'utf8')).toBe(REQUIRED_MD)
    expect(await readFile(join(out, 'guidelines', 'typescript.md'), 'utf8')).toContain('TS-002')
    const rounds = JSON.parse(await readFile(join(out, 'rounds.json'), 'utf8'))
    expect(rounds).toMatchObject({ mode: 'local', status: 'clean', knowledge: { path: knowledge, source: 'knowledge', files: ['INDEX.md', 'REQUIRED.md', 'typescript.md'] } })
    const calls = JSON.parse(await readFile(join(out, 'calls.json'), 'utf8'))
    expect(calls.system).toBe(systemPrompt)
    expect(calls.calls[0]).toMatchObject({ round: 1, batch: 1, output: { summary: 'fixed', unresolved: [] } })
    expect(calls.calls[0].prompt).toContain('DIAGNOSTICS TO FIX (2)')
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('Status: **clean**')
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('--local')
    expect(await readFile(join(web, '.gitignore'), 'utf8')).toBe('.static-analysis/\n')
    expect(result.orchestrator.text).toBe(await readFile(join(agentDir, 'agent', 'instructions.md'), 'utf8'))
    await expect(stat(workDirFor(out))).rejects.toThrow()
    const status = (await exec('git', ['-C', dir, 'status', '--porcelain'])).stdout.split('\n').filter(Boolean).sort()
    expect(status).toEqual(['?? apps/web/.gitignore', ' M apps/web/src/a.js', ' M apps/web/src/b.js'].sort())
  })

  it('reverts edits the agent\'s guards would reject: suppressions, protected files, new files', async () => {
    const { web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const first = pending(await runLocal({ source: web, maxRounds: 3 }, deps()))
    const original = await readFile(join(web, 'src/a.js'), 'utf8')
    await writeFile(join(web, 'src/a.js'), `// eslint-disable-next-line\n${original}`)
    await writeFile(join(web, 'package.json'), JSON.stringify({ name: 'web', scripts: { lint: 'true' } }))
    await writeFile(join(web, 'src/new.js'), 'export {}\n')
    await fixVars(web, ['src/b.js'])
    await writeFile(first.tasks[0]!.output, done([{ file: 'src/a.js', line: 1, reason: 'needs a decision' }]))
    const next = await runLocal({ source: web }, deps())
    expect(await readFile(join(web, 'src/a.js'), 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(web, 'package.json'), 'utf8'))).toMatchObject({ scripts: { lint: 'node lint.js' } })
    await expect(stat(join(web, 'src/new.js'))).rejects.toThrow()
    // Round 2 still sees a.js, so the session gets one more batch; answer it with nothing.
    const second = pending(next)
    expect(second).toMatchObject({ round: 2 })
    expect(second.tasks[0]!.files).toEqual(['src/a.js'])
    await writeFile(second.tasks[0]!.output, done([{ file: 'src/a.js', line: 1, reason: 'still needs a decision' }]))
    const result = finished(await runLocal({ source: web }, deps()))
    expect(result).toMatchObject({ status: 'partial', editedFiles: ['src/b.js'], remaining: 1 })
    expect(result.reason).toContain('no progress')
    expect(result.rejected.map((r) => [r.path, r.reason]).sort()).toEqual([
      ['package.json', expect.stringContaining('protected path')],
      ['src/a.js', expect.stringContaining('suppression')],
      ['src/new.js', expect.stringContaining('may not create files')],
    ])
    const rounds = JSON.parse(await readFile(join(web, '.static-analysis', 'rounds.json'), 'utf8'))
    expect(rounds.rounds[0].unresolved).toEqual(['src/a.js:1 needs a decision'])
  })

  it('asks for one retry on an invalid output, then --finish exports what exists', async () => {
    const { web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const first = pending(await runLocal({ source: web }, deps()))
    const task = first.tasks[0]!
    await writeFile(task.output, '{"summary": 3}')
    const retry = pending(await runLocal({ source: web }, deps()))
    expect(retry.tasks[0]).toMatchObject({ id: task.id, retry: true, prompt: task.prompt })
    expect(retry.tasks[0]!.error).toContain('summary')
    await writeFile(task.output, 'not json')
    const spent = pending(await runLocal({ source: web }, deps()))
    expect(spent.tasks[0]).toMatchObject({ id: task.id, retry: false })
    expect(spent.tasks[0]!.error).toContain('JSON')
    await fixVars(web, ['src/a.js'])
    const result = finished(await runLocal({ source: web, finish: true }, deps()))
    expect(result).toMatchObject({ status: 'partial', reason: 'finished early (--finish)', editedFiles: ['src/a.js'], remaining: 1 })
    expect(result.missing).toEqual([{ id: task.id, reason: expect.stringContaining('JSON') }])
  })

  it('stops at the round cap, after a last analysis of the final round\'s edits', async () => {
    const { web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const first = pending(await runLocal({ source: web, maxRounds: 1 }, deps()))
    await fixVars(web, ['src/a.js'])
    await writeFile(first.tasks[0]!.output, done())
    await expect(runLocal({ source: web, maxRounds: 2 }, deps())).rejects.toThrow('--max-rounds')
    const result = finished(await runLocal({ source: web }, deps()))
    expect(result).toMatchObject({ status: 'partial', reason: 'round cap (1) reached', rounds: 1, remaining: 1 })
  })

  it('with --no-fix only detects and analyzes: no auto-fix, no model stage, no write to the repository', async () => {
    const { dir, web } = await monorepo()
    const rules = join(dir, '..', `${dir.split('/').pop()}-rules`)
    await seedKnowledge(rules)
    const out = await realpath(await mkdtemp(join(tmpdir(), 'sa-local-out-')))
    const result = finished(await runLocal({ source: web, output: join(out, 'web'), knowledge: rules, noFix: true }, deps()))
    expect(result).toMatchObject({ status: 'partial', dir: join(out, 'web'), rounds: 0, initial: 2, remaining: 2, analyzers: ['script:lint'] })
    expect(result.reason).toContain('--no-fix')
    expect((await exec('git', ['-C', dir, 'status', '--porcelain'])).stdout).toBe('')
    expect(await readFile(join(out, 'web', 'report.md'), 'utf8')).toContain('script:lint')
    await rm(rules, { recursive: true, force: true })
  })

  it('refuses a remote repository: fetched code never runs on the host', async () => {
    await expect(runLocal({ source: 'aspiralabs/kit' }, deps())).rejects.toThrow('local path')
  })
})

describe('runLocal, the agent\'s own sources', () => {
  it('builds each prompt from fixer.ts as it is on that call', async () => {
    const changed = await agentCopy((source) => source.replace('You fix static-analysis diagnostics', 'VERSION TWO: you fix static-analysis diagnostics'))
    const { web, knowledge } = await monorepo()
    await seedKnowledge(knowledge)
    const input: LocalInput = { source: web }
    const text = await readFile(pending(await runLocal(input, { agentDir: changed, env: {} })).tasks[0]!.prompt, 'utf8')
    expect(text).toContain('## System\n\nVERSION TWO: you fix static-analysis diagnostics')
    expect(text).not.toContain(systemPrompt)
    const other = await monorepo()
    await seedKnowledge(other.knowledge)
    const original = await readFile(pending(await runLocal({ source: other.web }, deps())).tasks[0]!.prompt, 'utf8')
    expect(original).toContain(`## System\n\n${systemPrompt}\n`)
    expect(original).not.toContain('VERSION TWO')
  })

  it('validates outputs against the fixer\'s own done schema', () => {
    expect(doneSchema.safeParse(JSON.parse(done())).success).toBe(true)
    expect(doneSchema.safeParse({ summary: 'x' }).success).toBe(false)
  })
})
