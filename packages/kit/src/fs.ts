import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Log = (line: string) => void

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeIfAbsent(path: string, content: string, log: Log): boolean {
  if (existsSync(path)) {
    log(`keep   ${path} (exists)`)
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  log(`write  ${path}`)
  return true
}

export function deepMerge<T extends Record<string, unknown>>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k]
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
      continue
    }
    if (Array.isArray(cur) && Array.isArray(v)) {
      const seen = new Set(cur.map((x) => JSON.stringify(x)))
      out[k] = [...cur, ...v.filter((x) => !seen.has(JSON.stringify(x)))]
      continue
    }
    out[k] = v
  }
  return out as T
}

// The installed @aspiralabs/config package, so templates come from the version the project has.
export function configDir(projectRoot: string): string | undefined {
  const p = join(projectRoot, 'node_modules', '@aspiralabs', 'config')
  return existsSync(p) ? p : undefined
}
