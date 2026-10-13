// Argument parsing for `kit cleanup` and `kit worktree`. Each parser returns the parsed options
// ({ ok: true, ... }) or a usage error ({ ok: false, reason }) that cli.ts turns into the usage text and exit 2.
import { describe, expect, it } from 'vitest'
import { parseCleanupArgs, parseWorktreeArgs } from './command-args.js'

describe('parseCleanupArgs', () => {
  it('takes --yes, several paths after --only, and --app', () => {
    expect(parseCleanupArgs(['--yes', '--only', '/a', '/b', '--app', 'apps/web'])).toMatchObject({ ok: true, yes: true, only: ['/a', '/b'], app: 'apps/web' })
  })

  it('refuses an unknown flag, a positional argument, and --only without --yes', () => {
    expect([parseCleanupArgs(['--yse']).ok, parseCleanupArgs(['extra']).ok, parseCleanupArgs(['--only', '/a']).ok]).toEqual([false, false, false])
  })
})

describe('parseWorktreeArgs', () => {
  it('takes one ticket ID', () => {
    expect(parseWorktreeArgs(['KIT-13'])).toMatchObject({ ok: true, ref: 'KIT-13' })
  })

  it('refuses no ID, a value that is not a ticket, and an unknown flag', () => {
    expect([parseWorktreeArgs([]).ok, parseWorktreeArgs(['not a ticket']).ok, parseWorktreeArgs(['KIT-13', '--force']).ok]).toEqual([false, false, false])
  })
})
