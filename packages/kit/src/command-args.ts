// Argument parsing for `kit cleanup` and `kit worktree` (the arguments after the command name).
// Each parser returns the parsed options ({ ok: true, ... }) or a usage error ({ ok: false, reason })
// that cli.ts turns into the usage text and exit 2.
import { isTicketRef } from './ticket-handle.js'

export type UsageError = { ok: false; reason: string }

export type CleanupArgs = { ok: true; yes: boolean; only: string[] | undefined; app: string | undefined; cwd: string | undefined }

export type WorktreeArgs = { ok: true; ref: string; app: string | undefined; cwd: string | undefined }

const usageError = (reason: string): UsageError => ({ ok: false, reason })

const isFlag = (value: string) => value.startsWith('--')

/** The value after a flag that takes one: the next argument, unless it is missing or another flag. */
function flagValue(args: readonly string[], index: number): string | undefined {
  const value = args[index + 1]
  return value === undefined || isFlag(value) ? undefined : value
}

/** `kit cleanup [--yes [--only <path>...]] [--app <dir>] [--cwd <path>]`. */
export function parseCleanupArgs(args: readonly string[]): CleanupArgs | UsageError {
  let yes = false
  let only: string[] | undefined
  let app: string | undefined
  let cwd: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--yes') {
      yes = true
    } else if (arg === '--only') {
      const paths: string[] = []
      for (let next = args[i + 1]; next !== undefined && !isFlag(next); next = args[i + 1]) {
        paths.push(next)
        i++
      }
      if (paths.length === 0) return usageError('--only takes one or more worktree paths')
      only = [...(only ?? []), ...paths]
    } else if (arg === '--app' || arg === '--cwd') {
      const value = flagValue(args, i)
      if (value === undefined) return usageError(`${arg} takes a path`)
      if (arg === '--app') app = value
      else cwd = value
      i++
    } else if (isFlag(arg)) {
      return usageError(`unknown option for kit cleanup: ${arg}`)
    } else {
      return usageError(`kit cleanup takes no positional argument, got: ${arg}`)
    }
  }
  if (only !== undefined && !yes) return usageError('--only needs --yes')
  return { ok: true, yes, only, app, cwd }
}

/** `kit worktree <ID> [--app <dir>] [--cwd <path>]`. */
export function parseWorktreeArgs(args: readonly string[]): WorktreeArgs | UsageError {
  let ref: string | undefined
  let app: string | undefined
  let cwd: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--app' || arg === '--cwd') {
      const value = flagValue(args, i)
      if (value === undefined) return usageError(`${arg} takes a path`)
      if (arg === '--app') app = value
      else cwd = value
      i++
    } else if (isFlag(arg)) {
      return usageError(`unknown option for kit worktree: ${arg}`)
    } else if (ref !== undefined) {
      return usageError(`kit worktree takes one ticket ID, got a second: ${arg}`)
    } else if (!isTicketRef(arg)) {
      return usageError(`not a ticket: ${arg} (an ID such as KIT-13, or a Notion page URL)`)
    } else {
      ref = arg
    }
  }
  if (ref === undefined) return usageError('kit worktree needs a ticket ID, for example kit worktree KIT-13')
  return { ok: true, ref, app, cwd }
}
