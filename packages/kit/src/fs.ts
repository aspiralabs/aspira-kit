import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Log = (line: string) => void

// Reads JSON, and JSON with comments and trailing commas (tsconfig.json, .vscode/*.json), which
// TypeScript and editors accept and many projects use.
export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined
  }
  return JSON.parse(scanJsonc(readFileSync(path, 'utf8')).json) as T
}

/** Whether a JSON file has comments, which a rewrite through writeJson would drop. */
export function hasJsonComments(path: string): boolean {
  return existsSync(path) && scanJsonc(readFileSync(path, 'utf8')).comments
}

// Removes // and /* */ comments and trailing commas outside strings, so JSON.parse reads JSONC,
// and says whether there were comments.
export function scanJsonc(text: string): { json: string; comments: boolean } {
  let out = ''
  let comments = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      comments = true
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      comments = true
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (ch === ',') {
      // A trailing comma: only whitespace and comments before the closing bracket.
      let j = i + 1
      for (;;) {
        if (/\s/.test(text[j] ?? '')) j += 1
        else if (text.startsWith('//', j)) j = text.includes('\n', j) ? text.indexOf('\n', j) : text.length
        else if (text.startsWith('/*', j)) j = text.includes('*/', j + 2) ? text.indexOf('*/', j + 2) + 2 : text.length
        else break
      }
      if (text[j] === '}' || text[j] === ']') {
        i += 1
        continue
      }
    }
    out += ch
    i += 1
  }
  return { json: out, comments }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeIfAbsent(path: string, content: string, log: Log, dryRun = false): boolean {
  if (existsSync(path)) {
    log(`keep   ${path} (exists)`)
    return false
  }
  log(`write  ${path}`)
  if (dryRun) {
    return true
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
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
