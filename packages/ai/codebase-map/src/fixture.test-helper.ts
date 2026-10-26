// Test-only support for the codebase-map suites (KIT-69): real temp git repositories and the real
// scripts/cli.ts, run the way the kit runs it (node + amaro strip-types), observed through exit
// codes, stdout and the files under the map root. Nothing the kit owns is mocked (TEST-007).
//
// The contract these suites pin, where the spec leaves a name open:
//   CLI       node --import <amaro> --experimental-strip-types scripts/cli.ts --repo R --map-root M [command]
//             no command builds; --check checks; `brief <target>... [--json] [--kind k] [--changed]`;
//             `notes`, `notes accept <id>`, `notes retire <id>`. The map is M/map, the notes are M/notes.
//   build     stdout names the counts as "<n> files|internal|external|unresolved|parsed|reused|removed"
//             or "<label> <n>" (see count()).
//   graph     one node:sqlite file in map/; every row keeps the repo-relative path as text (or
//             "<prefix>:<path>"), edges carry kind internal|external|unresolved, nodes carry their
//             surface, env reads carry the variable name and the reading file.
//   manifest  map/manifest.json has a key matching /scanner/i and one matching /hash|files/i that maps
//             each path to its hash (SHA-256 hex of the content).
//   packet    brief --json prints the object brief() returns:
//             { kind, alsoMatched[], orientation, readFirst[], impact[], tests[], packages[], validation[],
//               notes[{id,text}], stale[{id,path}], omissions{ <list>: { count, first[] } } }
//             brief(options) is brief({ repo, mapRoot, target: string }) and may return a promise.
//   notes     one <id>.json per note: { id, status, text, evidence: [{ path, hash }] }. `notes` prints one
//             JSON object { stage: 'step', task, output }; the session writes { notes: [{ title, text,
//             paths }] } to `output` and runs `notes` again, which ingests them as candidates.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const exec = promisify(execFile)

export const SLOW = 180_000
export const CLI = fileURLToPath(new URL('../scripts/cli.ts', import.meta.url))

export type Files = Record<string, string>
export type Result = { code: number; stdout: string; stderr: string; out: string }
export type Packet = {
  kind: string
  alsoMatched: string[]
  orientation: string
  readFirst: string[]
  impact: string[]
  tests: string[]
  packages: string[]
  validation: string[]
  notes: { id: string; text: string }[]
  stale: { id: string; path: string }[]
  omissions: Record<string, { count: number; first: string[] }>
}
export type NoteFile = { id: string; status: string; text: string; evidence: { path: string; hash: string }[] }

// ---------------------------------------------------------------- temp dirs and git

const made: string[] = []

/** A new temp directory (symlinks resolved, as macOS's /var is one), removed by cleanup(). */
export async function tempDir(prefix = 'cmap-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

export async function cleanup(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', dir, ...args])).stdout.trim()
}

export async function writeFiles(dir: string, files: Files): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/**
 * A git repository on main with one commit holding `files` (and `symlinks`, link path to target),
 * then `untracked` written beside them. It lives at <temp>/<name>, so two repos can share a name.
 */
export async function makeRepo(files: Files, options: { name?: string; untracked?: Files; symlinks?: Record<string, string> } = {}): Promise<string> {
  const dir = join(await tempDir(), options.name ?? 'repo')
  await mkdir(dir)
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFiles(dir, files)
  for (const [path, target] of Object.entries(options.symlinks ?? {})) await symlink(target, join(dir, path))
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  await writeFiles(dir, options.untracked ?? {})
  return dir
}

export const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
export const fileHash = async (repo: string, path: string): Promise<string> => sha256(await readFile(join(repo, path)))

/** `count` files named <prefix>NNN.ts, each exporting one constant, as a Files map. */
export function generated(count: number, prefix: string, body = (n: number) => `export const v${n} = ${n}\n`): Files {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${String(i + 1).padStart(3, '0')}.ts`, body(i + 1)]))
}

// ---------------------------------------------------------------- the CLI

function amaro(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'node_modules', 'amaro', 'dist', 'register-strip.mjs')
    if (existsSync(candidate)) return candidate
    const up = dirname(dir)
    if (up === dir) throw new Error('amaro (the TypeScript loader the kit spawns scripts with) is not installed')
    dir = up
  }
}

const nodeArgs = (): string[] => ['--import', amaro(), '--experimental-strip-types', CLI]

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of ['NOTION_TOKEN', 'NOTION_API_KEY', 'OPENROUTER_API_KEY']) delete env[name]
  return env
}

const result = (code: number, stdout: string, stderr: string): Result => ({ code, stdout, stderr, out: `${stdout}\n${stderr}` })

export async function cli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Result> {
  try {
    const run = await exec('node', [...nodeArgs(), ...args], { cwd: options.cwd ?? tmpdir(), env: childEnv(options.env), maxBuffer: 64 * 1024 * 1024 })
    return result(0, run.stdout, run.stderr)
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string }
    return result(typeof failed.code === 'number' ? failed.code : 1, failed.stdout ?? '', failed.stderr ?? '')
  }
}

/** The same call, left running: for the test that kills a build part-way. */
export function startCli(args: string[], cwd: string): { child: ChildProcess; done: Promise<Result> } {
  const child = spawn('node', [...nodeArgs(), ...args], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => (stdout += String(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => (stderr += String(chunk)))
  const done = new Promise<Result>((resolve) => child.on('close', (code) => resolve(result(code ?? -1, stdout, stderr))))
  return { child, done }
}

export const inRepo = (repo: string): string => join(repo, '.codebase-map')
const scope = (repo: string, mapRoot: string): string[] => ['--repo', repo, '--map-root', mapRoot]

export const build = (repo: string, mapRoot = inRepo(repo)): Promise<Result> => cli(scope(repo, mapRoot), { cwd: repo })
export const check = (repo: string, mapRoot = inRepo(repo)): Promise<Result> => cli([...scope(repo, mapRoot), '--check'], { cwd: repo })
export const briefCli = (repo: string, mapRoot: string, targets: string[], flags: string[] = []): Promise<Result> => cli([...scope(repo, mapRoot), 'brief', ...targets, ...flags], { cwd: repo })
export const notesCli = (repo: string, mapRoot: string, ...args: string[]): Promise<Result> => cli([...scope(repo, mapRoot), 'notes', ...args], { cwd: repo })

/** brief --json, parsed; fails the test when the brief exits non-zero. */
export async function packetOf(repo: string, mapRoot: string, targets: string[], flags: string[] = []): Promise<Packet> {
  const run = await briefCli(repo, mapRoot, targets, ['--json', ...flags])
  if (run.code !== 0) throw new Error(`brief ${targets.join(' ')} exited ${run.code}: ${run.out}`)
  return JSON.parse(run.stdout) as Packet
}

/** One counted label of the build summary: "3 files", "files: 3" and "files 3" all read as 3. */
export function count(stdout: string, label: string): number {
  const match = new RegExp(`${label}\\w*(?:\\s+edges)?[:=]?\\s+(\\d+)|(\\d+)\\s+${label}`, 'i').exec(stdout)
  if (match === null) throw new Error(`the build output has no "${label}" count:\n${stdout}`)
  return Number(match[1] ?? match[2])
}

// ---------------------------------------------------------------- map artifacts

export const mapDir = (mapRoot: string): string => join(mapRoot, 'map')
export const notesDir = (mapRoot: string): string => join(mapRoot, 'notes')

export async function readManifest(mapRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(mapDir(mapRoot), 'manifest.json'), 'utf8')) as Record<string, unknown>
}

/** The manifest's per-file hashes as path to the entry's JSON, whether it keeps an object or a list. */
export function hashesOf(manifest: Record<string, unknown>): Record<string, string> {
  const key = Object.keys(manifest).find((name) => /hash|files/i.test(name))
  const value = key === undefined ? undefined : manifest[key]
  if (Array.isArray(value)) return Object.fromEntries((value as { path: string }[]).map((entry) => [entry.path, JSON.stringify(entry)]))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([path, entry]) => [path, JSON.stringify(entry)]))
  throw new Error(`the manifest has no per-file hashes: ${JSON.stringify(Object.keys(manifest))}`)
}

/** Every file under `dir` as relative path to the SHA-256 of its bytes; {} when the folder is absent. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out[full.slice(dir.length + 1)] = sha256(await readFile(full))
    }
  }
  await walk(dir)
  return out
}

export type Row = { table: string; values: string[] }

/** Every row of every table of the map's graph, values as text. */
export function graphRows(mapRoot: string): Row[] {
  const folder = mapDir(mapRoot)
  const file = readdirSync(folder).find((name) => /\.(db|sqlite3?)$/.test(name))
  if (file === undefined) throw new Error(`no SQLite graph in ${folder}`)
  const db = new DatabaseSync(join(folder, file), { readOnly: true })
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]
    return tables.flatMap(({ name }) => (db.prepare(`select * from "${name}"`).all() as Record<string, unknown>[]).map((row) => ({ table: name, values: Object.values(row).map((value) => (value === null || value === undefined ? '' : String(value))) })))
  } finally {
    db.close()
  }
}

export const hasValue = (row: Row, value: string): boolean => row.values.some((entry) => entry === value || entry.endsWith(`:${value}`))
export const KINDS = ['internal', 'external', 'unresolved']
/** The edge rows that leave `path`. */
export const edgesFrom = (rows: Row[], path: string): Row[] => rows.filter((row) => hasValue(row, path) && row.values.some((value) => KINDS.includes(value)))

// ---------------------------------------------------------------- notes

export async function readNotes(mapRoot: string): Promise<Record<string, NoteFile>> {
  const folder = notesDir(mapRoot)
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith('.json'))
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name.slice(0, -5), JSON.parse(await readFile(join(folder, name), 'utf8')) as NoteFile] as const)))
}

/** A note file written by hand: its evidence hashes are the cited files' current ones unless `hash` is given. */
export async function handNote(repo: string, mapRoot: string, note: { id: string; status?: string; text: string; paths: string[]; hash?: string }): Promise<string> {
  const evidence = await Promise.all(note.paths.map(async (path) => ({ path, hash: note.hash ?? (await fileHash(repo, path).catch(() => '0'.repeat(64))) })))
  const file = join(notesDir(mapRoot), `${note.id}.json`)
  await mkdir(notesDir(mapRoot), { recursive: true })
  await writeFile(file, `${JSON.stringify({ id: note.id, title: note.id, status: note.status ?? 'accepted', text: note.text, evidence }, null, 2)}\n`)
  return file
}

/** Two `notes` runs with the proposals written to the output file the first one names; returns the second run. */
export async function proposeNotes(repo: string, mapRoot: string, notes: { title: string; text: string; paths: string[] }[]): Promise<{ first: Result; second: Result; stage: { stage: string; task: string; output: string } }> {
  const first = await notesCli(repo, mapRoot)
  const stage = JSON.parse(first.stdout.trim()) as { stage: string; task: string; output: string }
  await mkdir(dirname(stage.output), { recursive: true })
  await writeFile(stage.output, JSON.stringify({ notes }))
  const second = await notesCli(repo, mapRoot)
  return { first, second, stage }
}

/** The ids of the note files in a map root's notes folder. */
export async function noteIds(mapRoot: string): Promise<string[]> {
  return Object.keys(await readNotes(mapRoot)).sort()
}

/** A small TypeScript repository: package.json with scripts, and src/a.ts to src/c.ts importing in a chain. */
export const CHAIN: Files = {
  'package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' } }),
  'src/a.ts': "import { b } from './b.ts'\nexport const a = b + 1\n",
  'src/b.ts': "import { c } from './c.ts'\nexport const b = c + 1\n",
  'src/c.ts': 'export const c = 1\n',
}
