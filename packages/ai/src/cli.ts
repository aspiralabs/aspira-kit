#!/usr/bin/env node
// kit init --stack next [--app <dir>] [--board <url>] [--releases <url>] [--dry-run] [--cwd <path>]
// kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
// kit doctor [--app <dir>] [--cwd <path>]
// kit next [<ticket>] [--app <dir>] [--cwd <path>]
// kit cleanup [--yes] [--only <path>...] [--app <dir>] [--cwd <path>]
// kit worktree <ticket> [--install] [--app <dir>] [--cwd <path>]
// kit playbook
// kit package-dir (prints this @aspiralabs/ai's directory; the /aspira-* launchers find the global install with it)
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { appRoot, readApp, resolveProjectRoot, writeAspira } from './aspira.js'
import { cleanup, type Ask } from './cleanup.js'
import { parseCleanupArgs, parseWorktreeArgs } from './command-args.js'
import { doctor } from './doctor.js'
import { next } from './next.js'
import { renderPlaybook } from './playbook.js'
import { initNext, KIT_VERSION } from './stacks/next.js'
import { addAuthNext } from './stacks/next-auth.js'
import { kitPackageDir } from './skills.js'
import { checkVersion } from './version-check.js'
import { worktree } from './worktree.js'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string): string | boolean | undefined => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) {
    return undefined
  }
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
// The project root: --cwd, else the working directory. For doctor, next, cleanup and worktree, a working directory
// inside the app of a multi-app project (apps/web, where the kit's bin is) stands for the root that wired it.
const explicitCwd = typeof flag('cwd') === 'string' ? resolve(flag('cwd') as string) : undefined
const rootFromApp = command === 'doctor' || command === 'next' || command === 'cleanup' || command === 'worktree'
const cwd = explicitCwd ?? (rootFromApp ? resolveProjectRoot(process.cwd()) : process.cwd())
const log = (line: string) => console.log(line)
// --app <dir>: the app that owns package.json and node_modules, relative to the root (apps/web).
const appFlag = flag('app')

const usage = `usage:
  kit init --stack next [--app <dir>] [--board <Feature Board URL>] [--releases <Releases page URL>] [--dry-run] [--cwd <path>]
  kit init --board <Feature Board URL> [--releases <Releases page URL>] [--cwd <path>]
  kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
  kit doctor [--app <dir>] [--cwd <path>]
  kit next [<ticket>] [--app <dir>] [--cwd <path>]
  kit cleanup [--yes] [--only <path>...] [--app <dir>] [--cwd <path>]
  kit worktree <ticket> [--install] [--app <dir>] [--cwd <path>]
  kit playbook

  --app <dir>: in a repository whose app (package.json, node_modules) is not the root, that directory,
  relative to the root the command runs in (for example apps/web). Package files are written there,
  the Claude-facing files at the root, and aspira.json records it so doctor and next need no flag.`

async function main(): Promise<number> {
  if (appFlag === true) {
    console.error(`--app takes the app's directory, relative to the project root (for example apps/web)\n${usage}`)
    return 2
  }
  const app = typeof appFlag === 'string' ? appFlag : undefined
  if (command === 'init') {
    const stack = flag('stack')
    const board = flag('board')
    const releases = flag('releases')
    if (board === true || releases === true) {
      console.error(`--board and --releases take a Notion URL\n${usage}`)
      return 2
    }
    if (stack === undefined && typeof board === 'string') {
      // Only the board: an existing project adds its Feature Board without re-running the stack.
      writeAspira({ projectRoot: cwd, board, ...(typeof releases === 'string' ? { releases } : {}), ...(app !== undefined ? { app } : {}), dryRun: flag('dry-run') === true, log })
      return 0
    }
    if (stack !== 'next') {
      console.error(`unknown or missing --stack (have: next)\n${usage}`)
      return 2
    }
    await initNext({ projectRoot: cwd, dryRun: flag('dry-run') === true, log, ...(app !== undefined ? { app } : {}), ...(typeof board === 'string' ? { board } : {}), ...(typeof releases === 'string' ? { releases } : {}) })
    return 0
  }
  if (command === 'next') {
    const ticket = argv[1] !== undefined && !argv[1].startsWith('--') ? argv[1] : undefined
    return next(cwd, ticket, log, undefined, app)
  }
  if (command === 'cleanup') {
    const args = parseCleanupArgs(argv.slice(1))
    if (!args.ok) {
      console.error(`${args.reason}\n${usage}`)
      return 2
    }
    return cleanup({ projectRoot: cwd, app: args.app, yes: args.yes, only: args.only, ask: terminalAsk(), log, warn: (line) => console.error(line) })
  }
  if (command === 'worktree') {
    const args = parseWorktreeArgs(argv.slice(1))
    if (!args.ok) {
      console.error(`${args.reason}\n${usage}`)
      return 2
    }
    return worktree({ projectRoot: cwd, app: args.app, ref: args.ref, install: args.install, log })
  }
  if (command === 'playbook') {
    process.stdout.write(renderPlaybook())
    return 0
  }
  if (command === 'add') {
    if (argv[1] !== 'auth') {
      console.error(`unknown or missing feature (have: auth)\n${usage}`)
      return 2
    }
    const expo = flag('expo')
    if (expo === true) {
      console.error(`--expo needs the app's URL scheme\n${usage}`)
      return 2
    }
    addAuthNext({ projectRoot: cwd, dryRun: flag('dry-run') === true, log, passkey: flag('no-passkey') !== true, expo: typeof expo === 'string' ? expo : undefined })
    return 0
  }
  if (command === 'doctor') {
    return doctor(cwd, log, app)
  }
  console.error(usage)
  return 2
}

/** The confirmation reader for kit cleanup: only on an interactive terminal; null on end of input. */
function terminalAsk(): Ask | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  return async (prompt) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await reader.question(`${prompt} `)
    } catch {
      return null
    } finally {
      reader.close()
    }
  }
}

/**
 * Inside a project whose app still has its own kit (node_modules/.bin/kit, from a kit before global installs), a global
 * kit hands over to that copy, as the launchers do. Returns the copy's exit code, or undefined to carry on with this copy.
 */
function projectCopyExit(): number | undefined {
  if (process.env.ASPIRA_KIT_REEXEC !== undefined || command === 'version-check' || command === 'package-dir') return undefined
  try {
    const root = explicitCwd ?? resolveProjectRoot(process.cwd())
    if (!existsSync(join(root, 'aspira.json'))) return undefined
    const appDir = appRoot(root, typeof appFlag === 'string' ? appFlag : readApp(root))
    const bin = join(appDir, 'node_modules', '.bin', 'kit')
    if (!existsSync(bin) || process.argv[1] === undefined) return undefined
    const running = realpathSync(process.argv[1])
    if (running === realpathSync(bin)) return undefined
    for (const dir of [appDir, root]) {
      const modules = join(dir, 'node_modules')
      if (existsSync(modules) && running.startsWith(realpathSync(modules) + sep)) return undefined
    }
    const result = spawnSync(bin, argv, { stdio: 'inherit', env: { ...process.env, ASPIRA_KIT_REEXEC: '1' } })
    if (result.error) return undefined
    return result.status ?? 1
  } catch {
    return undefined
  }
}

/** The daily upgrade notice, on stderr after the command's own output. Never changes anything else. */
async function printNotice(): Promise<void> {
  try {
    if (KIT_VERSION === undefined) return
    const notice = await checkVersion({ surface: 'kit', running: KIT_VERSION })
    if (notice) process.stderr.write(`${notice}\n`)
  } catch {
    // the check is best effort
  }
}

try {
  const handedOver = projectCopyExit()
  if (handedOver !== undefined) process.exit(handedOver)
  if (command === 'package-dir') {
    process.stdout.write(`${kitPackageDir()}\n`)
    process.exit(0)
  }
  if (command === 'version-check') {
    // The SessionStart hook's entry point: the notice on stdout, nothing else, always exit 0.
    const notice = KIT_VERSION === undefined ? undefined : await checkVersion({ surface: 'hook', running: KIT_VERSION })
    if (notice) process.stdout.write(`${notice}\n`)
    process.exit(0)
  }
  const code = await main()
  if (command !== 'playbook') await printNotice()
  process.exit(code)
} catch (err) {
  console.error(`error  ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
