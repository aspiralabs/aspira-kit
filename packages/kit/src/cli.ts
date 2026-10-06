#!/usr/bin/env node
// kit init --stack next [--board <url>] [--releases <url>] [--dry-run] [--cwd <path>]
// kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
// kit doctor [--cwd <path>]
// kit next [<ticket>] [--cwd <path>]
// kit playbook
import { resolve } from 'node:path'
import { writeAspira } from './aspira.js'
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
const cwd = resolve(typeof flag('cwd') === 'string' ? (flag('cwd') as string) : process.cwd())
const log = (line: string) => console.log(line)

const usage = `usage:
  kit init --stack next [--board <Feature Board URL>] [--releases <Releases page URL>] [--dry-run] [--cwd <path>]
  kit init --board <Feature Board URL> [--releases <Releases page URL>] [--cwd <path>]
  kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
  kit doctor [--cwd <path>]
  kit next [<ticket>] [--cwd <path>]
  kit playbook`

async function main(): Promise<number> {
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
      writeAspira({ projectRoot: cwd, board, ...(typeof releases === 'string' ? { releases } : {}), dryRun: flag('dry-run') === true, log })
      return 0
    }
    if (stack !== 'next') {
      console.error(`unknown or missing --stack (have: next)\n${usage}`)
      return 2
    }
    await initNext({ projectRoot: cwd, dryRun: flag('dry-run') === true, log, ...(typeof board === 'string' ? { board } : {}), ...(typeof releases === 'string' ? { releases } : {}) })
    return 0
  }
  if (command === 'next') {
    const ticket = argv[1] !== undefined && !argv[1].startsWith('--') ? argv[1] : undefined
    return next(cwd, ticket, log)
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
    return doctor(cwd, log)
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
