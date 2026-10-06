#!/usr/bin/env node
// kit init --stack next [--app <dir>] [--board <url>] [--releases <url>] [--dry-run] [--cwd <path>]
// kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
// kit doctor [--app <dir>] [--cwd <path>]
// kit next [<ticket>] [--app <dir>] [--cwd <path>]
// kit playbook
import { resolve } from 'node:path'
import { resolveProjectRoot, writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { next } from './next.js'
import { renderPlaybook } from './playbook.js'
import { initNext } from './stacks/next.js'
import { addAuthNext } from './stacks/next-auth.js'

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
// The project root: --cwd, else the working directory. For doctor and next, a working directory inside
// the app of a multi-app project (apps/web, where the kit's bin is) stands for the root that wired it.
const explicitCwd = typeof flag('cwd') === 'string' ? resolve(flag('cwd') as string) : undefined
const cwd = explicitCwd ?? (command === 'doctor' || command === 'next' ? resolveProjectRoot(process.cwd()) : process.cwd())
const log = (line: string) => console.log(line)
// --app <dir>: the app that owns package.json and node_modules, relative to the root (apps/web).
const appFlag = flag('app')

const usage = `usage:
  kit init --stack next [--app <dir>] [--board <Feature Board URL>] [--releases <Releases page URL>] [--dry-run] [--cwd <path>]
  kit init --board <Feature Board URL> [--releases <Releases page URL>] [--cwd <path>]
  kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
  kit doctor [--app <dir>] [--cwd <path>]
  kit next [<ticket>] [--app <dir>] [--cwd <path>]
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

try {
  process.exit(await main())
} catch (err) {
  console.error(`error  ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
