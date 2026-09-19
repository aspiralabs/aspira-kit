#!/usr/bin/env node
// kit init --stack next [--dry-run] [--cwd <path>]
// kit doctor [--cwd <path>]
import { resolve } from 'node:path'
import { doctor } from './doctor.js'
import { initNext } from './stacks/next.js'

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
  if (command === 'doctor') {
    return doctor(cwd, log)
  }
  console.error(usage)
  return 2
}

process.exit(await main())
