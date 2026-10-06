// Where this package is on the host, from where a module of it is running. At launch eve runs
// the authored modules from a compiled copy under the package's own `.eve/dev-runtime/snapshots/
// <id>/source/…` (or `.eve/compile/…`), which holds only compiled modules and package files: a
// path built from `import.meta.url` with `../..` lands inside that copy, where no persona.md,
// reviews/ or any other authored file exists. The first launch of the renamed personas died on
// exactly that. Every host-side read of a package file resolves through here instead.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Reviewer } from './review.ts'

export const PACKAGE_NAME = '@aspiralabs/pr-reviewer'

/** The eve directories a running module may sit under; the real package root is what precedes them. */
const EVE_RUNTIME_SEGMENTS = ['/.eve/dev-runtime/snapshots/', '/.eve/compile/', '/.eve/builds/']

const isThisPackage = (dir: string): boolean => {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return manifest.name === PACKAGE_NAME
  } catch {
    return false
  }
}

/**
 * The package directory for a module at `moduleUrl` (its `import.meta.url`): the app root before
 * an eve runtime segment, else the nearest ancestor whose package.json is this package (the
 * source layout, as tests and --local run it). Throws rather than guess: a wrong directory here
 * is a silent empty read at best and a failed launch at worst.
 */
export function packageDirFrom(moduleUrl: string): string {
  const path = fileURLToPath(moduleUrl)
  for (const segment of EVE_RUNTIME_SEGMENTS) {
    const at = path.indexOf(segment)
    if (at >= 0) {
      const root = path.slice(0, at)
      if (isThisPackage(root)) return root
    }
  }
  let dir = dirname(path)
  for (;;) {
    if (isThisPackage(dir)) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) throw new Error(`Cannot find the ${PACKAGE_NAME} package directory from ${path}: no eve runtime segment and no ancestor package.json names it.`)
    dir = parent
  }
}

/**
 * Every file the agent reads from the package on the host at launch, relative to the package.
 * The launch test resolves each one the way the runtime does and requires it to exist; a rename
 * that forgets a reader fails there instead of in load-pr on the first run.
 */
export const LAUNCH_FILES = {
  persona: (who: Reviewer) => `agent/subagents/${who}/persona.md`,
  /** The seats' dynamic system instruction, compiled by eve; listed so a rename fails the test too. */
  sharedInstruction: (who: Reviewer) => `agent/subagents/${who}/instructions/shared.ts`,
  /** Where previous reviews' cost.md files are looked for (a missing directory is fine; a wrong root is not). */
  reviews: 'reviews',
} as const

/** The package root this module runs from, resolved once. */
export const PACKAGE_DIR = packageDirFrom(import.meta.url)

/** A package file as an absolute host path, with the same check the launch test makes. */
export function packageFile(relative: string): string {
  const path = join(PACKAGE_DIR, relative)
  if (!existsSync(path) && relative !== LAUNCH_FILES.reviews) throw new Error(`${relative} is missing from ${PACKAGE_DIR}; every file in LAUNCH_FILES must exist there.`)
  return path
}
