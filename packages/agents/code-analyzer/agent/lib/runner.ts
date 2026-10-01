import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SandboxSession } from 'eve/sandbox'
import { detect, type Analyzer, type Detection } from './analyzers.ts'
import { hostExecutor, sandboxExecutor, shellQuote, type Executor } from './executor.ts'
import { createFixer } from './fixer.ts'
import { Ledger } from './ledger.ts'
import { runLoop, type Fixer, type LoopResult } from './loop.ts'
import { renderReport } from './report.ts'
import { branchName, cloneCommand, parseSource, redact, type Source } from './source.ts'

export type RunInput = { source: string; ref?: string; push?: boolean; maxRounds?: number; maxCostUsd?: number; outputDir?: string; fixWarnings?: boolean }
export type RunDeps = { getSandbox?: () => Promise<SandboxSession>; signal?: AbortSignal; progress?: (message: string) => void; fixer?: Fixer; now?: () => Date }

const env = (name: string, fallback: string) => process.env[name] || fallback
const number = (value: number | undefined, name: string, fallback: number) => value ?? (Number(process.env[name]) || fallback)

/** Probes each analyzer's binary; installs in the sandbox, drops it on the host. */
export async function prepareToolchain(executor: Executor, analyzers: Analyzer[], progress?: (m: string) => void): Promise<{ ready: Analyzer[]; unavailable: string[]; notes: string[] }> {
  const ready: Analyzer[] = []
  const unavailable: string[] = []
  const notes: string[] = []
  const installed = new Set<string>()
  for (const analyzer of analyzers) {
    if (!analyzer.requires) { ready.push(analyzer); continue }
    let present = (await executor.run(`command -v ${shellQuote(analyzer.requires)}`, { timeoutMs: 20_000 })).exitCode === 0
    if (!present && executor.canInstall && !installed.has(analyzer.requires)) {
      installed.add(analyzer.requires)
      progress?.(`install ${analyzer.requires}`)
      for (const command of analyzer.install) {
        const result = await executor.run(command, { timeoutMs: 900_000 })
        if (result.exitCode !== 0) { notes.push(`install ${analyzer.requires}: exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-400)}`); break }
      }
      present = (await executor.run(`command -v ${shellQuote(analyzer.requires)}`, { timeoutMs: 20_000 })).exitCode === 0
    }
    if (present) ready.push(analyzer)
    else unavailable.push(`${analyzer.id} (needs ${analyzer.requires})`)
  }
  return { ready, unavailable, notes }
}

export async function runSetup(executor: Executor, detection: Detection, progress?: (m: string) => void): Promise<string[]> {
  const notes: string[] = []
  for (const step of detection.setup) {
    if (executor.kind === 'host') {
      if (!step.hostWhenMissing || (await executor.exists(step.hostWhenMissing))) continue
    }
    progress?.(`setup ${step.command}`)
    const result = await executor.run(step.command, { timeoutMs: 900_000 })
    if (result.exitCode !== 0) notes.push(`setup "${step.command}": exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-400)}`)
  }
  return notes
}

async function repositoryInstructions(executor: Executor): Promise<string> {
  const parts: string[] = []
  for (const path of ['AGENTS.md', 'CLAUDE.md', 'node_modules/@aspiralabs/config/agent/constraints.md', '.github/copilot-instructions.md']) {
    const text = await executor.readFile(path)
    if (text) parts.push(`SOURCE ${path}\n${text.slice(0, 8_000)}`)
  }
  return parts.join('\n\n')
}

export async function runStaticAnalysis(input: RunInput, deps: RunDeps = {}) {
  const started = Date.now()
  const progress = deps.progress
  const source = await parseSource(input.source)
  const token = process.env.GITHUB_TOKEN
  let executor: Executor
  let sandbox: SandboxSession | null = null
  if (source.kind === 'local') executor = hostExecutor(source.root)
  else {
    if (!deps.getSandbox) throw new Error('A remote repository needs the eve sandbox; use the eve entry point (fetched code never runs on the host).')
    sandbox = await deps.getSandbox()
    progress?.(`clone ${source.label}`)
    const clone = await sandbox.run({ command: cloneCommand(source, token, '/workspace/repo', input.ref) })
    if (clone.exitCode !== 0) throw new Error(`Clone of ${source.label} failed (exit ${clone.exitCode}): ${redact(clone.stderr || clone.stdout, token)}`)
    executor = sandboxExecutor(sandbox, '/workspace/repo')
  }
  const label = source.kind === 'local' ? source.root : source.label
  const files = await executor.listFiles()
  const detection = await detect(files, (path) => executor.readFile(path))
  const toolchain = await prepareToolchain(executor, detection.analyzers, progress)
  const setupNotes = toolchain.ready.length ? await runSetup(executor, detection, progress) : []
  detection.notes.push(...toolchain.notes, ...setupNotes)
  const ledger = new Ledger(started)
  const calls: Parameters<typeof createFixer>[0]['calls'] = []
  const model = env('STATIC_ANALYSIS_FIX_MODEL', 'openai/gpt-6.1-sol')
  const fixer = deps.fixer ?? createFixer({ executor, model, ledger, calls, started, instructions: await repositoryInstructions(executor), timeoutMs: Number(process.env.STATIC_ANALYSIS_BATCH_TIMEOUT_MS) || 180_000 })
  const prepareMs = Date.now() - started
  const loopStarted = Date.now()
  let result: LoopResult
  try {
    result = await runLoop(executor, toolchain.ready, fixer, {
      maxRounds: number(input.maxRounds, 'STATIC_ANALYSIS_MAX_ROUNDS', 6),
      maxCostUsd: number(input.maxCostUsd, 'STATIC_ANALYSIS_MAX_COST_USD', 5),
      costSoFar: () => ledger.costUsd(),
      fixWarnings: input.fixWarnings ?? process.env.STATIC_ANALYSIS_WARNINGS === 'fix',
      commandTimeoutMs: Number(process.env.STATIC_ANALYSIS_COMMAND_TIMEOUT_MS) || 600_000,
      concurrency: Number(process.env.STATIC_ANALYSIS_CONCURRENCY) || 3,
      signal: deps.signal, progress,
    })
  } finally { ledger.failRunning() }
  const loopMs = Date.now() - loopStarted
  const publishStarted = Date.now()
  const outputDir = resolve(input.outputDir ?? (source.kind === 'local' ? join(source.root, '.static-analysis') : join(tmpdir(), 'static-analysis', `${source.owner}-${source.name}`)))
  let remote: { branch: string; commit: string | null; pushed: boolean; pullRequest: string | null } | null = null
  let patch: string | null = null
  if (source.kind === 'remote' && sandbox) {
    remote = await commitRemote(executor, source, token, input.push === true, result, deps.now?.() ?? new Date())
    if (remote.commit) patch = (await executor.run(`git format-patch --stdout HEAD~1`, { timeoutMs: 60_000 })).stdout
  }
  const timing = { prepareMs, loopMs, publishMs: 0, totalMs: 0 }
  const write = async () => {
    timing.publishMs = Date.now() - publishStarted
    timing.totalMs = Date.now() - started
    const report = renderReport({ label, where: executor.kind, result, detection, unavailable: toolchain.unavailable, turns: ledger.turns, model, timing, remote })
    await mkdir(outputDir, { recursive: true })
    const files: Record<string, string> = {
      'report.md': report,
      'diagnostics.json': JSON.stringify({ status: result.status, remaining: result.remaining, initial: result.initial }, null, 2),
      'rounds.json': JSON.stringify({ status: result.status, reason: result.reason, rounds: result.rounds, problems: result.problems, rejected: result.rejected, editedFiles: result.editedFiles, detection: { ...detection, analyzers: detection.analyzers.map(({ parse: _p, ...a }) => a) }, unavailable: toolchain.unavailable, timing, remote }, null, 2),
      'usage.json': JSON.stringify({ scope: 'Model turns of the fix loop only. Aborted turns may have unreported provider usage.', model, turns: ledger.turns }, null, 2),
      'calls.json': JSON.stringify({ system: 'see fixer.ts systemPrompt', model, calls: calls.map((c) => ({ ...c, output: c.output && redactOutput(c.output) })) }, null, 2),
    }
    if (patch) files['changes.patch'] = patch
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(outputDir, name), content, 'utf8')))
  }
  await write()
  if (source.kind === 'local') await ignoreOutput(source.root)
  return { status: result.status, reason: result.reason, dir: outputDir, label, rounds: result.rounds.length, initial: result.initial.length, remaining: result.remaining.length, editedFiles: result.editedFiles, rejected: result.rejected.length, problems: result.problems.map((p) => p.split('\n')[0]!), unavailable: toolchain.unavailable, reportedCostUsd: ledger.costUsd(), totalMs: Date.now() - started, remote }
}

const redactOutput = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

/** Adds the output folder to the repository's .gitignore once, the way the PR reviewer does. */
export async function ignoreOutput(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  const current = await readFile(path, 'utf8').catch(() => '')
  if (current.split('\n').some((line) => line.trim() === '.static-analysis/' || line.trim() === '.static-analysis')) return
  await writeFile(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.static-analysis/\n`, 'utf8')
}

export async function commitRemote(executor: Executor, source: Extract<Source, { kind: 'remote' }>, token: string | undefined, push: boolean, result: LoopResult, now: Date) {
  const branch = branchName(now)
  const name = env('STATIC_ANALYSIS_GIT_NAME', 'aspira-code-analyzer-agent')
  const email = env('STATIC_ANALYSIS_GIT_EMAIL', 'noreply@aspiralabs.co')
  const dirty = (await executor.run('git status --porcelain', { timeoutMs: 60_000 })).stdout.trim()
  await executor.run(`git checkout -q -b ${shellQuote(branch)}`, { timeoutMs: 60_000 })
  if (!dirty) return { branch, commit: null, pushed: false, pullRequest: null }
  const message = `chore: fix static analysis findings\n\n${result.initial.length} → ${result.remaining.length} diagnostics over ${result.rounds.length} round(s); status ${result.status}.\nFiles edited by the fixer: ${result.editedFiles.length}. Auto-fixers ran for every detected analyzer.\n\nGenerated by @aspiralabs/code-analyzer.`
  const commit = await executor.run(`git add -A && git -c user.name=${shellQuote(name)} -c user.email=${shellQuote(email)} commit -q -m ${shellQuote(message)} && git rev-parse HEAD`, { timeoutMs: 120_000 })
  if (commit.exitCode !== 0) throw new Error(`Commit failed: ${commit.stderr || commit.stdout}`)
  const sha = commit.stdout.trim().split('\n').pop() ?? null
  let pushed = false
  let pullRequest: string | null = null
  if (push) {
    const url = token ? source.url.replace('https://', `https://x-access-token:${token}@`) : source.url
    const pushed_ = await executor.run(`git push -q ${shellQuote(url)} HEAD:refs/heads/${shellQuote(branch)}`, { timeoutMs: 300_000 })
    if (pushed_.exitCode !== 0) throw new Error(`Push failed: ${redact(pushed_.stderr || pushed_.stdout, token)}`)
    pushed = true
    if (token) {
      const base = (await executor.run('git symbolic-ref -q --short refs/remotes/origin/HEAD || git rev-parse --abbrev-ref HEAD@{upstream}', { timeoutMs: 30_000 })).stdout.trim().replace(/^origin\//, '') || 'main'
      const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.name}/pulls`, { method: 'POST', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'aspiralabs-code-analyzer', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'chore: fix static analysis findings', head: branch, base, body: message }) })
      if (response.ok) pullRequest = ((await response.json()) as { html_url?: string }).html_url ?? null
      else result.problems.push(`pull request: GitHub API ${response.status}`)
    }
  }
  return { branch, commit: sha, pushed, pullRequest }
}
