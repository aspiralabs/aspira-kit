import { join, resolve } from 'node:path'

// The eve tools take paths from the model, and the card and the page are untrusted input, so a tool
// call must never reach a repository or a folder the launcher did not start the run on. The launcher
// exports both as GROOMER_REPO and GROOMER_FOLDER to the eve process; every tool checks its path
// against them and refuses anything else, including a run started without them.

export type BoundRun = { repoPath: string; folder: string; output: string }

/** The repository and working folder the launcher started this run on; throws when either is unset. */
export function boundRun(env: NodeJS.ProcessEnv = process.env): BoundRun {
  const repo = env.GROOMER_REPO?.trim()
  const folder = env.GROOMER_FOLDER?.trim()
  if (!repo || !folder) throw new Error('GROOMER_REPO and GROOMER_FOLDER are not set; the groomer tools run only under the launcher, which binds them to the run')
  return { repoPath: resolve(repo), folder: resolve(folder), output: join(resolve(folder), 'groom') }
}

/** Returns `path` resolved when it is the bound one; throws naming both paths otherwise. */
export function requireBound(kind: 'repository' | 'folder' | 'output', path: string, env: NodeJS.ProcessEnv = process.env): string {
  const run = boundRun(env)
  const bound = kind === 'repository' ? run.repoPath : kind === 'folder' ? run.folder : run.output
  if (resolve(path) !== bound) throw new Error(`this run is bound to the ${kind} ${bound}; refused ${path}`)
  return bound
}
