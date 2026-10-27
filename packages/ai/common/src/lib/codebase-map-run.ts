// KIT-70: the one place the spec writer, planner and pr-reviewer use the KIT-69 codebase map. A run asks
// `mapBriefForRun` once: it returns the neutralized brief (used) or exactly one reason (not used), and saves the
// answer in the run's work folder so every later call of the same run returns the same text without touching the
// map. The opt-in is the aspira.json `useCodebaseMap` key (off when absent); a cloud run never reads a map.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BriefError, brief, formatBrief, type BriefPacket } from '@aspiralabs/ai/codebase-map'
import { buildMapCaptured, mapRootFor, useCodebaseMap } from '@aspiralabs/ai/map-codebase'

const exec = promisify(execFile)

export type MapStatus = { used: boolean; text: string; reason?: string; report: string }
export type HiddenNote = { id: string; path: string }
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }

export type MapRunInput = {
  repo: string
  /** The run's work folder: the first answer is saved here. */
  workDir: string
  cloud?: boolean
  /** Files, directories or workspace package names; unknown and deleted ones are dropped and counted. */
  targets?: string[]
  /** Text to pull candidate targets out of when `targets` is not given (see `targetsFromText`). */
  text?: string
  /** One extra line appended after the brief. */
  instruction?: string
  /** Accepted notes stored in these files (changed by the PR under review) show as id and path only. */
  hiddenNotes?: HiddenNote[]
  pollMs?: number
  clock?: Clock
}

const SAVED = 'codebase-map-brief.json'
const WAIT_MS = 120_000
const REPORT = 'Codebase map: '
const LISTS: Record<string, string> = { readFirst: 'read-first files', impact: 'impact files', tests: 'test files', packages: 'packages', validation: 'validation commands', notes: 'notes' }

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/g
const flat = (text: string): string => text.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim()

const notUsed = (reason: string): MapStatus => ({ used: false, text: '', reason, report: `${REPORT}not used (${reason})` })

/** Candidate targets in free text: tokens that look like a path, a file name or a scoped package name. */
export function targetsFromText(text: string): string[] {
  const found = new Set<string>()
  for (const raw of text.split(/[\s`'"(),;:[\]{}<>|]+/)) {
    const token = raw.replace(/^\.\//, '').replace(/[.,]+$/, '')
    if (token.length > 1 && (token.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(token))) found.add(token)
  }
  return [...found]
}

/** A refusal that only means "no usable map yet": the build then makes one. */
const NEEDS_BUILD = /no codebase map|is stale|no readable graph/

async function probe(repo: string, mapRoot: string): Promise<string | undefined> {
  try {
    await brief({ repo, mapRoot, targets: [] })
    return 'unexpected'
  } catch (error) {
    if (error instanceof BriefError && !NEEDS_BUILD.test(error.message)) return undefined
    return error instanceof Error ? error.message : String(error)
  }
}

const lastLine = (text: string): string => {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return flat(lines[lines.length - 1] ?? 'no error output').slice(0, 300)
}

/** Whether the map root's build lock names a live process (the build script takes `.build.lock` with its pid). */
function buildRunning(mapRoot: string): boolean {
  try {
    const pid = Number(readFileSync(join(mapRoot, '.build.lock'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Makes sure a fresh map exists: undefined when it does, else the one `build failed: ...` reason. */
async function ensureMap(repo: string, mapRoot: string, pollMs: number, clock: Clock): Promise<string | undefined> {
  const started = clock.now()
  let lastError = ''
  for (;;) {
    const state = await probe(repo, mapRoot)
    if (state === undefined) return undefined
    lastError = state
    let code = 1
    let stderr = state
    if (buildRunning(mapRoot)) stderr = `a build is running in ${mapRoot}`
    else {
      try {
        ;({ code, stderr } = buildMapCaptured(repo, mapRoot))
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error)
      }
    }
    if (code === 0) {
      const after = await probe(repo, mapRoot)
      return after === undefined ? undefined : `build failed: ${lastLine(after)}`
    }
    lastError = stderr
    if (!/a build is running/.test(stderr)) return `build failed: ${lastLine(lastError)}`
    if (clock.now() - started >= WAIT_MS) return `build failed: ${lastLine(lastError)}`
    await clock.sleep(pollMs)
  }
}

async function gitLines(repo: string, args: string[]): Promise<string[]> {
  try {
    return (await exec('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean)
  } catch {
    return []
  }
}

/** Tracked files (that exist on disk) and workspace package names, to sort a target into path, package or dropped. */
async function classify(repo: string, targets: string[]): Promise<{ paths: string[]; packages: string[]; dropped: number }> {
  const tracked = (await gitLines(repo, ['ls-files', '-z'])).filter((path) => existsSync(join(repo, path)))
  const files = new Set(tracked)
  const names = new Set<string>()
  for (const path of tracked) {
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(repo, path), 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string') names.add(parsed.name)
    } catch {
      // an unreadable package.json names no package
    }
  }
  const paths = new Set<string>()
  const packages = new Set<string>()
  let dropped = 0
  for (const target of new Set(targets.map((entry) => entry.trim()).filter(Boolean))) {
    const dir = target.replace(/^\.\//, '').replace(/\/+$/, '')
    if (files.has(dir) || (dir !== '' && tracked.some((path) => path.startsWith(`${dir}/`)))) paths.add(dir)
    else if (names.has(target)) packages.add(target)
    else dropped++
  }
  return { paths: [...paths], packages: [...packages], dropped }
}

/**
 * The packet as text with repo-controlled strings neutralized: accepted notes keep the fence, with a marker inside a
 * note rewritten and its lines indented under the id; every other line is single-line without control characters;
 * notes stored in `hiddenNotes` files show as id and path only (with the stale ones).
 */
export function neutralizeBrief(packet: BriefPacket, hiddenNotes: HiddenNote[] = []): string {
  const hidden = new Map(hiddenNotes.map((note) => [note.id, note.path]))
  const shown = packet.notes.filter((note) => !hidden.has(note.id))
  const hiddenShown = packet.notes.filter((note) => hidden.has(note.id)).map((note) => ({ id: note.id, path: hidden.get(note.id) ?? '' }))
  const fenceSafe = (line: string): string => line.replace(/<<</g, '< < <').replace(/>>>/g, '> > >')
  const noteText = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((line) => fenceSafe(line.replace(CONTROL, ' ')).trim())
      .filter(Boolean)
      .join('\n    ')
  const omissions: BriefPacket['omissions'] = {}
  for (const [list, info] of Object.entries(packet.omissions)) omissions[list as keyof BriefPacket['omissions']] = { count: info.count, first: info.first.map(flat) }
  const clean: BriefPacket = {
    ...packet,
    kind: flat(packet.kind),
    alsoMatched: packet.alsoMatched.map(flat),
    readFirst: packet.readFirst.map(flat),
    impact: packet.impact.map(flat),
    tests: packet.tests.map(flat),
    packages: packet.packages.map(flat),
    validation: packet.validation.map(flat),
    notes: shown.map((note) => ({ id: flat(note.id), text: noteText(note.text) })),
    stale: [...packet.stale, ...hiddenShown].map((note) => ({ id: flat(note.id), path: flat(note.path) })),
    omissions,
  }
  return formatBrief(clean)
}

function cutLists(packets: BriefPacket[]): string[] {
  const cut = new Set<string>()
  for (const packet of packets) for (const [list, info] of Object.entries(packet.omissions)) cut.add(`${LISTS[list] ?? list} (${info.count} left out)`)
  return [...cut]
}

function readSaved(workDir: string): MapStatus | undefined {
  try {
    const saved = JSON.parse(readFileSync(join(workDir, SAVED), 'utf8')) as MapStatus
    return typeof saved.used === 'boolean' && typeof saved.text === 'string' && typeof saved.report === 'string' ? saved : undefined
  } catch {
    return undefined
  }
}

function save(workDir: string, status: MapStatus): MapStatus {
  try {
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, SAVED), JSON.stringify(status, null, 2))
  } catch {
    // a run folder that cannot be written still gets its answer once
  }
  return status
}

/**
 * Whether this run uses the codebase map, and the brief when it does. Precedence of the reasons: opt-in off,
 * cloud run, build failed, brief refused, no usable target. The first call of a run decides and saves; later
 * calls return the saved answer byte for byte without checking the map again.
 */
export async function mapBriefForRun(input: MapRunInput): Promise<MapStatus> {
  if (!useCodebaseMap(input.repo)) return notUsed('opt-in off')
  if (input.cloud === true) return notUsed('cloud run')
  const saved = readSaved(input.workDir)
  if (saved !== undefined) return saved

  const mapRoot = mapRootFor(input.repo, input.repo)
  const failed = await ensureMap(input.repo, mapRoot, input.pollMs ?? 1000, input.clock ?? realClock)
  if (failed !== undefined) return save(input.workDir, notUsed(failed))

  const targets = input.targets ?? targetsFromText(input.text ?? '')
  const sorted = await classify(input.repo, targets)
  if (sorted.paths.length === 0 && sorted.packages.length === 0) return save(input.workDir, notUsed('no usable target'))

  const packets: BriefPacket[] = []
  try {
    if (sorted.paths.length > 0) packets.push(await brief({ repo: input.repo, mapRoot, targets: sorted.paths, kind: 'path' }))
    if (sorted.packages.length > 0) packets.push(await brief({ repo: input.repo, mapRoot, targets: sorted.packages, kind: 'package' }))
  } catch (error) {
    if (error instanceof BriefError) return save(input.workDir, notUsed(`brief refused: ${flat(error.message)}`))
    throw error
  }

  const parts = packets.map((packet, index) => {
    const text = neutralizeBrief(packet, input.hiddenNotes)
    return index === 0 ? text : text.split('\n').filter((line) => line !== packet.orientation).join('\n')
  })
  if (input.instruction !== undefined) parts.push(flat(input.instruction))
  const impactFiles = packets.reduce((sum, packet) => sum + packet.impact.length + (packet.omissions.impact?.count ?? 0), 0)
  const notes = [sorted.dropped > 0 ? `${sorted.dropped} target${sorted.dropped === 1 ? '' : 's'} dropped` : '', `${impactFiles} impact files`, ...cutLists(packets).map((entry) => `cut ${entry}`)].filter(Boolean)
  const report = `${REPORT}used${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`
  return save(input.workDir, { used: true, text: parts.join('\n\n'), report })
}
