// `kit map-codebase`: resolves the repo that holds the working directory and the map root (the aspira.json
// `codebaseMaps` folder plus the main checkout's directory name, else <repo>/.codebase-map), then runs
// codebase-map/scripts/cli.ts through node + amaro and returns its exit code. It never imports codebase-map/.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { codebaseMapsFolder } from './aspira.js'

export { useCodebaseMap } from './aspira.js'
import { mainCheckoutRoot, repositoryRoot } from './git.js'
import { aiPackageDir } from './skills.js'

const AMARO = join('amaro', 'dist', 'register-strip.mjs')

/** The first `<ancestor of dir>/node_modules/<relative>` that exists, as Node resolution would find it. */
function findUpModule(dir: string, relative: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    if (dirname(current) === current) return undefined
  }
}

const subfolders = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Git repositories among the children and grandchildren of `dir` (relative paths), skipping node_modules. */
function nearbyRepos(dir: string): string[] {
  const found: string[] = []
  for (const child of subfolders(dir)) {
    if (existsSync(join(dir, child, '.git'))) {
      found.push(child)
      continue
    }
    for (const grandchild of subfolders(join(dir, child))) if (existsSync(join(dir, child, grandchild, '.git'))) found.push(`${child}/${grandchild}`)
  }
  return found
}

/** Spawns the map script for `repo` and `mapRoot` with the user's remaining arguments; returns its exit code. */
export function runMapScript(repo: string, mapRoot: string, args: readonly string[]): number {
  const ai = aiPackageDir()
  if (ai === undefined) {
    console.error('error  @aspiralabs/ai is not installed; cannot run the codebase map')
    return 1
  }
  const script = join(ai, 'codebase-map', 'scripts', 'cli.ts')
  if (!existsSync(script)) {
    console.error(`error  ${script} is missing`)
    return 1
  }
  const amaro = findUpModule(realpathSync(ai), AMARO) ?? findUpModule(realpathSync(repo), AMARO)
  if (amaro === undefined) {
    console.error('error  amaro (the TypeScript loader the agents ship with) is not installed')
    return 1
  }
  const run = spawnSync('node', ['--import', amaro, '--experimental-strip-types', script, '--repo', repo, '--map-root', mapRoot, ...args], { cwd: repo, stdio: ['inherit', 'inherit', 'inherit'] })
  return run.status ?? 1
}

/** The map root for `repo` as `kit map-codebase` computes it: the aspira.json `codebaseMaps` folder plus the main checkout's name, else <repo>/.codebase-map. Throws on an invalid `codebaseMaps` value. */
export function mapRootFor(cwd: string, repo: string): string {
  const folder = codebaseMapsFolder(cwd, repo)
  return folder === undefined ? join(repo, '.codebase-map') : join(folder, basename(mainCheckoutRoot(repo) ?? repo))
}

/** KIT-70: how long an agent run's map build may take before it is killed and the run goes on without the map. */
export const BUILD_TIMEOUT_MS = 120_000

/**
 * KIT-70: builds the map for `repo` into `mapRoot` like `kit map-codebase`, with stdout and stderr captured so an agent
 * run's own output stays clean. A build still running after `timeoutMs` is killed and reported as a failed build.
 */
export function buildMapCaptured(repo: string, mapRoot: string, timeoutMs: number = BUILD_TIMEOUT_MS): { code: number; stderr: string } {
  const ai = aiPackageDir()
  if (ai === undefined) return { code: 1, stderr: '@aspiralabs/ai is not installed; cannot run the codebase map' }
  const script = join(ai, 'codebase-map', 'scripts', 'cli.ts')
  if (!existsSync(script)) return { code: 1, stderr: `${script} is missing` }
  const amaro = findUpModule(realpathSync(ai), AMARO) ?? findUpModule(realpathSync(repo), AMARO)
  if (amaro === undefined) return { code: 1, stderr: 'amaro (the TypeScript loader the agents ship with) is not installed' }
  mkdirSync(join(mapRoot, 'notes'), { recursive: true })
  const run = spawnSync('node', ['--import', amaro, '--experimental-strip-types', script, '--repo', repo, '--map-root', mapRoot], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' })
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || run.signal !== null) return { code: 1, stderr: `build timed out after ${timeoutMs / 1000}s` }
  return { code: run.status ?? 1, stderr: run.stderr ?? '' }
}

/** `kit map-codebase [args]` from `cwd`. Outside a git repository nothing is written. */
export function mapCodebase(cwd: string, args: readonly string[], log: (line: string) => void): number {
  const repo = repositoryRoot(cwd)
  if (repo === undefined) {
    console.error(`${cwd} is not inside a git repository; run kit map-codebase from inside one.`)
    const repos = nearbyRepos(cwd)
    if (repos.length === 0) console.error('no git repos were found below it either.')
    else {
      console.error('git repos below it:')
      for (const found of repos) console.error(`  ${found}`)
    }
    return 1
  }
  let mapRoot: string
  try {
    mapRoot = mapRootFor(cwd, repo)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  void log
  // a build keeps the notes beside the map; the scripts only create the map
  if (args.length === 0) mkdirSync(join(mapRoot, 'notes'), { recursive: true })
  return runMapScript(repo, mapRoot, args)
}
