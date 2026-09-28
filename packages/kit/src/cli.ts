#!/usr/bin/env node
// kit init --stack next [--dry-run] [--cwd <path>]
// kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
// kit doctor [--cwd <path>]
import { resolve } from 'node:path'
import { doctor } from './doctor.js'
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
  kit init --stack next [--dry-run] [--cwd <path>]
  kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
  kit doctor [--cwd <path>]`

async function main(): Promise<number> {
  if (command === 'init') {
    const stack = flag('stack')
    if (stack !== 'next') {
      console.error(`unknown or missing --stack (have: next)\n${usage}`)
      return 2
    }
    await initNext({ projectRoot: cwd, dryRun: flag('dry-run') === true, log })
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
