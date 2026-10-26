// The daily "a newer @aspiralabs/ai exists" check, shared by the kit CLI (stderr) and the SessionStart hook (JSON).
// Standard library only. It never throws, never logs, and never returns or writes the token or an error body.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Surface = 'kit' | 'hook'

export const VERSION_CACHE = join('.cache', 'aspiralabs', 'version-check.json')

const REGISTRY = 'https://npm.pkg.github.com'
const PACKUMENT = '/@aspiralabs%2fai'
const DAY = 24 * 60 * 60 * 1000
const TIMEOUT = 2000
const VERSION = /^\d+\.\d+\.\d+$/
const TOKEN_LINE = '//npm.pkg.github.com/:_authToken='
const TOKEN = /^[A-Za-z0-9_.\-~+/=]+$/

type Cache = { checkedAt: number; latest?: string; failed?: true; notified: Partial<Record<Surface, number>> }

export type CheckOptions = {
  surface: Surface
  /** The version of the @aspiralabs/ai copy that executes. */
  running: string
  home?: string
  now?: () => number
  /** Test only: the registry base. The CLI and the hook always use https://npm.pkg.github.com. */
  registry?: string
}

/** The token from the user-level ~/.npmrc only: never a project .npmrc or an npm_config_* variable. */
export function readUserToken(home: string): string | undefined {
  try {
    const rc = join(home, '.npmrc')
    if (home === '' || !existsSync(rc)) return undefined
    for (const raw of readFileSync(rc, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line.startsWith(TOKEN_LINE)) continue
      const token = line.slice(TOKEN_LINE.length).trim()
      return TOKEN.test(token) ? token : undefined
    }
  } catch {
    // unreadable: no token
  }
  return undefined
}

/** The one line shown to the user. Built from fixed text and two validated versions. */
export function versionNotice(latest: string, running: string): string {
  return `@aspiralabs/ai ${latest} is available (you have ${running}). Upgrade: kit update`
}

function newer(latest: string, running: string): boolean {
  const a = latest.split('.').map(Number)
  const b = running.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

function readCache(file: string): Cache | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as Record<string, unknown>
    if (typeof o.checkedAt !== 'number' || !Number.isFinite(o.checkedAt)) return undefined
    const notified: Cache['notified'] = {}
    const n = typeof o.notified === 'object' && o.notified !== null ? (o.notified as Record<string, unknown>) : {}
    for (const surface of ['kit', 'hook'] as const) {
      if (typeof n[surface] === 'number' && Number.isFinite(n[surface])) notified[surface] = n[surface]
    }
    if (o.failed === true) return { checkedAt: o.checkedAt, failed: true, notified }
    if (typeof o.latest !== 'string' || !VERSION.test(o.latest)) return undefined
    return { checkedAt: o.checkedAt, latest: o.latest, notified }
  } catch {
    return undefined
  }
}

function writeCache(file: string, cache: Cache): boolean {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // nothing to clean
    }
    return false
  }
}

async function fetchLatest(registry: string, token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${registry}${PACKUMENT}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    const body: unknown = JSON.parse(await response.text())
    const tags = typeof body === 'object' && body !== null ? (body as { 'dist-tags'?: unknown })['dist-tags'] : undefined
    const latest = typeof tags === 'object' && tags !== null ? (tags as { latest?: unknown }).latest : undefined
    return typeof latest === 'string' && VERSION.test(latest) ? latest : undefined
  } catch {
    return undefined
  }
}

/** The notice text, or undefined. Never throws. */
export async function checkVersion(options: CheckOptions): Promise<string | undefined> {
  try {
    const { surface, running } = options
    if (!VERSION.test(running)) return undefined
    const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
    if (home === '') return undefined
    const now = (options.now ?? Date.now)()
    const file = join(home, VERSION_CACHE)

    let cache = readCache(file)
    if (cache === undefined || now - cache.checkedAt < 0 || now - cache.checkedAt >= DAY) {
      const token = readUserToken(home)
      const latest = token === undefined ? undefined : await fetchLatest(options.registry ?? REGISTRY, token)
      // Re-read just before writing so a concurrent check's notification record is kept.
      const notified = (readCache(file) ?? cache)?.notified ?? {}
      cache = latest === undefined ? { checkedAt: now, failed: true, notified } : { checkedAt: now, latest, notified }
      writeCache(file, cache)
    }
    if (cache.latest === undefined || !newer(cache.latest, running)) return undefined

    // Claim the notification: the synchronous re-read and write let two checks in one process print once.
    const current = readCache(file) ?? cache
    const last = current.notified[surface]
    if (last !== undefined && now - last >= 0 && now - last < DAY) return undefined
    writeCache(file, { ...current, notified: { ...current.notified, [surface]: now } })
    return versionNotice(cache.latest, running)
  } catch {
    return undefined
  }
}
