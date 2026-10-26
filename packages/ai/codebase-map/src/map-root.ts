// Where a repo's map and notes live under a map root. In the repo (.codebase-map) or in a harness folder outside it, the
// map is <map root>/map and the notes are <map root>/notes. A linked worktree mapped into a map root outside itself keeps
// its own map in <map root>/worktrees/<worktree directory name>/map and shares the notes, so it never overwrites the
// main checkout's map.

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type MapDirs = { mapDir: string; notesDir: string }

async function gitPath(repo: string, flag: string): Promise<string | undefined> {
  const out = await exec('git', ['-C', repo, 'rev-parse', '--path-format=absolute', flag]).then((run) => run.stdout.trim(), () => '')
  return out === '' ? undefined : await realpath(out).catch(() => out)
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The map/ and notes/ folders for `repo` under `mapRoot`. */
export async function mapDirs(repo: string, mapRoot: string): Promise<MapDirs> {
  const notesDir = join(mapRoot, 'notes')
  const [gitDir, commonDir, top] = await Promise.all([gitPath(repo, '--git-dir'), gitPath(repo, '--git-common-dir'), gitPath(repo, '--show-toplevel')])
  const linked = gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir
  const outside = top !== undefined && !inside(top, await realpath(resolve(mapRoot)).catch(() => resolve(mapRoot)))
  if (linked && outside) return { mapDir: join(mapRoot, 'worktrees', basename(top), 'map'), notesDir }
  return { mapDir: join(mapRoot, 'map'), notesDir }
}
