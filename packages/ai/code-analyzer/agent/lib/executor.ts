import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { SandboxSession } from 'eve/sandbox'
import { worktreeDatabaseEnv, worktreeIdentity } from '@aspiralabs/ai/common/lib/worktree-env'

export type RunResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = { cwd?: string; timeoutMs?: number; signal?: AbortSignal }

/** One command/file surface over either the host checkout or the eve sandbox.
 * Every path is repository-relative; `root` is the absolute repo root in the executor's own namespace. */
export interface Executor {
  readonly kind: 'host' | 'sandbox'
  readonly root: string
  /** Sandbox only: toolchains may be installed. The host never installs. */
  readonly canInstall: boolean
  run(command: string, options?: RunOptions): Promise<RunResult>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Tracked plus untracked-but-not-ignored files, repository-relative. */
  listFiles(): Promise<string[]>
}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** Rejects `..`, absolute paths and anything not under the root; returns the normalized relative path. */
export function insideRoot(root: string, path: string): string | null {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** Credentials an analyzer command never gets, whether or not they are set: the same list build-feature's gate unsets (packages/ai/build-feature/src/gate.ts). The Notion token is for the knowledge walk only (F52). */
export const CREDENTIALS = ['NOTION_TOKEN', 'NOTION_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_GATEWAY_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'] as const
/** A variable named like a credential. */
const CREDENTIAL_NAME = /_(TOKEN|SECRET|KEY|PASSWORD)$/i
const FIXED_CREDENTIALS = new Set<string>(CREDENTIALS)

/** The environment a host analyzer command runs in: `env` without any credential, plus CI-style output settings. */
export function analyzerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !FIXED_CREDENTIALS.has(name) && !CREDENTIAL_NAME.test(name)))
  return { ...kept, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
}

export function hostExecutor(root: string): Executor {
  // KIT-67 Q1: in an isolated worktree the branch's database variables go over the process env, so no command reaches the shared database; credentials stay stripped.
  const childEnv = async (): Promise<NodeJS.ProcessEnv> => analyzerEnv({ ...process.env, ...((await worktreeIdentity(root)) === null ? {} : await worktreeDatabaseEnv(root)) })
  const exec = async (command: string, options: RunOptions = {}): Promise<RunResult> => {
    const env = await childEnv()
    return new Promise((done) => {
      const cwd = options.cwd ? resolve(root, options.cwd) : root
      const child = execFile('bash', ['-c', command], { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs, killSignal: 'SIGKILL', signal: options.signal }, (error, stdout, stderr) => {
        const killed = Boolean(error && 'killed' in error && (error as { killed?: boolean }).killed)
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
        done({ exitCode: killed ? 124 : code, stdout: String(stdout), stderr: String(stderr), timedOut: killed && Boolean(options.timeoutMs) })
      })
      void child
    })
  }
  return {
    kind: 'host', root, canInstall: false, run: exec,
    async readFile(path) {
      const rel = insideRoot(root, path)
      if (rel === null) return null
      return readFile(resolve(root, rel), 'utf8').catch(() => null)
    },
    async writeFile(path, content) {
      const rel = insideRoot(root, path)
      if (rel === null) throw new Error(`Path escapes repository: ${path}`)
      await mkdir(dirname(resolve(root, rel)), { recursive: true })
      await writeFile(resolve(root, rel), content, 'utf8')
    },
    async exists(path) {
      const rel = insideRoot(root, path)
      if (rel === null) return false
      return access(resolve(root, rel)).then(() => true, () => false)
    },
    async listFiles() {
      const result = await exec('git ls-files -z -co --exclude-standard')
      return result.stdout.split('\0').filter(Boolean)
    },
  }
}

export function sandboxExecutor(sandbox: SandboxSession, root = '/workspace/repo'): Executor {
  const run = async (command: string, options: RunOptions = {}): Promise<RunResult> => {
    const cwd = options.cwd ? resolve(root, options.cwd) : root
    const seconds = Math.max(1, Math.ceil((options.timeoutMs ?? 600_000) / 1000))
    // `timeout` (coreutils) bounds the command inside the sandbox; 124 is its exit code on expiry.
    const result = await sandbox.run({ command: `cd ${shellQuote(cwd)} && CI=1 FORCE_COLOR=0 NO_COLOR=1 timeout -k 5 ${seconds} bash -c ${shellQuote(command)}` })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.exitCode === 124 }
  }
  return {
    kind: 'sandbox', root, canInstall: true, run,
    async readFile(path) {
      const rel = insideRoot(root, path)
      if (rel === null) return null
      try { return await sandbox.readTextFile({ path: resolve(root, rel) }) } catch { return null }
    },
    async writeFile(path, content) {
      const rel = insideRoot(root, path)
      if (rel === null) throw new Error(`Path escapes repository: ${path}`)
      await sandbox.writeTextFile({ path: resolve(root, rel), content })
    },
    async exists(path) {
      const rel = insideRoot(root, path)
      if (rel === null) return false
      const result = await run(`test -e ${shellQuote(rel)}`)
      return result.exitCode === 0
    },
    async listFiles() {
      const result = await run('git ls-files -z -co --exclude-standard')
      return result.stdout.split('\0').filter(Boolean)
    },
  }
}
