import { isAbsolute, join, normalize, relative } from 'node:path'
import type { Diagnostic, Severity } from './diagnostics.ts'

/** Where a command ran: `cwd` is repository-relative ('' at the root), `root` is the absolute repo root. */
export type Location = { cwd: string; root: string }
/** Returns diagnostics, or null when the output cannot be read as this tool's format. */
export type Parser = (stdout: string, stderr: string, where: Location) => Diagnostic[] | null

export function repoPath(where: Location, path: string): string {
  const clean = path.trim().replace(/^\.\//, '')
  const absolute = isAbsolute(clean) ? clean : join(where.root, where.cwd, clean)
  const rel = relative(where.root, absolute)
  return normalize(rel).replaceAll('\\', '/')
}

const make = (tool: string, where: Location, file: string, line: number | null, column: number | null, message: string, rule: string | null, severity: Severity): Diagnostic =>
  ({ tool, file: repoPath(where, file), line, column, message: message.trim(), rule, severity })

/** Finds the first JSON value in noisy stdout (package managers print banners before tool output). */
export function firstJson(text: string, open: '[' | '{'): unknown {
  const start = text.indexOf(open)
  if (start < 0) return null
  const close = text.lastIndexOf(open === '[' ? ']' : '}')
  if (close < start) return null
  try { return JSON.parse(text.slice(start, close + 1)) } catch { return null }
}

export const eslintJson: Parser = (stdout, _stderr, where) => {
  const data = firstJson(stdout, '[')
  if (!Array.isArray(data)) return null
  return data.flatMap((entry) => {
    const file = (entry as { filePath?: string }).filePath
    const messages = (entry as { messages?: unknown[] }).messages
    if (typeof file !== 'string' || !Array.isArray(messages)) return []
    return messages.map((m) => {
      const msg = m as { line?: number; column?: number; message?: string; ruleId?: string | null; severity?: number; fatal?: boolean }
      return make('eslint', where, file, msg.line ?? null, msg.column ?? null, msg.message ?? '', msg.ruleId ?? (msg.fatal ? 'fatal' : null), msg.severity === 2 || msg.fatal ? 'error' : 'warning')
    })
  })
}

export const eslintStylish: Parser = (stdout, _stderr, where) => {
  const out: Diagnostic[] = []
  let file: string | null = null
  let seen = false
  for (const line of stdout.split('\n')) {
    const row = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?\s*$/)
    if (row && file) { seen = true; out.push(make('eslint', where, file, Number(row[1]), Number(row[2]), row[4]!, row[5] ?? null, row[3] as Severity)); continue }
    if (/^\S.*[\\/].*$|^\S+\.[a-z]+$/.test(line) && !/^\d+ problems?/.test(line) && !line.startsWith('>') && !line.startsWith('$') && !line.includes(' ')) file = line.trim()
  }
  return seen || /^\s*✖?\s*0 problems|^$/m.test(stdout) || stdout.trim() === '' ? out : null
}

export const tsc: Parser = (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  const pattern = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
  let matched = false
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.match(pattern)
    if (row) { matched = true; out.push(make('tsc', where, row[1]!, Number(row[2]), Number(row[3]), row[6]!, row[5]!, row[4] as Severity)); continue }
    if (/^\s+\S/.test(line) && out.length) out[out.length - 1]!.message += ` ${line.trim()}`
  }
  if (!matched && /error TS\d+/.test(stdout + stderr)) return null
  return out
}

export const prettier: Parser = (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.match(/^\[warn\] (.+)$/)
    if (row && !/^Code style issues found|^Run Prettier/.test(row[1]!)) out.push(make('prettier', where, row[1]!, null, null, 'File is not formatted with Prettier', 'format', 'error'))
  }
  return out
}

/** GitHub Actions annotation format, used by Biome (`--reporter=github`) and others. */
export const githubAnnotations = (tool: string): Parser => (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.match(/^::(error|warning|notice) (.*?)::(.*)$/)
    if (!row) continue
    const attrs = Object.fromEntries(row[2]!.split(',').map((pair) => pair.split('=') as [string, string]))
    if (!attrs.file) continue
    out.push(make(tool, where, attrs.file, attrs.line ? Number(attrs.line) : null, attrs.col ? Number(attrs.col) : null, row[3]!.replaceAll('%0A', '\n'), attrs.title ?? null, row[1] === 'error' ? 'error' : 'warning'))
  }
  return out
}

export const ruffJson: Parser = (stdout, _stderr, where) => {
  const data = firstJson(stdout, '[')
  if (!Array.isArray(data)) return null
  return data.map((entry) => {
    const e = entry as { code?: string | null; message?: string; filename?: string; location?: { row?: number; column?: number } }
    return make('ruff', where, e.filename ?? '', e.location?.row ?? null, e.location?.column ?? null, e.message ?? '', e.code ?? null, 'error')
  })
}

export const wouldReformat = (tool: string, pattern: RegExp): Parser => (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.match(pattern)
    if (row) out.push(make(tool, where, row[1]!, null, null, `File is not formatted with ${tool}`, 'format', 'error'))
  }
  return out
}
export const ruffFormat = wouldReformat('ruff-format', /^Would reformat: (.+)$/)
export const black = wouldReformat('black', /^would reformat (.+)$/)
export const gofmt: Parser = (stdout, _stderr, where) => stdout.split('\n').filter((l) => l.trim() && !l.startsWith('go: ')).map((l) => make('gofmt', where, l, null, null, 'File is not gofmt-formatted', 'format', 'error'))
export const cargoFmt = wouldReformat('cargo-fmt', /^Diff in (.+?) at line \d+:?$/)

export const mypy: Parser = (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.match(/^(.+?):(\d+)(?::(\d+))?: (error|warning): (.*?)(?:\s+\[([\w-]+)\])?$/)
    if (row) out.push(make('mypy', where, row[1]!, Number(row[2]), row[3] ? Number(row[3]) : null, row[5]!, row[6] ?? null, row[4] as Severity))
  }
  return out
}

export const pyright: Parser = (stdout, _stderr, where) => {
  const data = firstJson(stdout, '{') as { generalDiagnostics?: unknown[] } | null
  if (!data || !Array.isArray(data.generalDiagnostics)) return null
  return data.generalDiagnostics.map((entry) => {
    const e = entry as { file?: string; severity?: string; message?: string; rule?: string; range?: { start?: { line?: number; character?: number } } }
    return make('pyright', where, e.file ?? '', e.range?.start?.line !== undefined ? e.range.start.line + 1 : null, e.range?.start?.character !== undefined ? e.range.start.character + 1 : null, e.message ?? '', e.rule ?? null, e.severity === 'error' ? 'error' : 'warning')
  })
}

export const rubocopJson: Parser = (stdout, _stderr, where) => {
  const data = firstJson(stdout, '{') as { files?: unknown[] } | null
  if (!data || !Array.isArray(data.files)) return null
  return data.files.flatMap((entry) => {
    const f = entry as { path?: string; offenses?: unknown[] }
    return (f.offenses ?? []).map((o) => {
      const off = o as { message?: string; cop_name?: string; location?: { start_line?: number; start_column?: number } }
      return make('rubocop', where, f.path ?? '', off.location?.start_line ?? null, off.location?.start_column ?? null, off.message ?? '', off.cop_name ?? null, 'error')
    })
  })
}

/** `path:line[:col]: [severity:] message`, the shape of go vet, golangci-lint, flake8 and `cargo --message-format short`. */
export const colonLines = (tool: string, defaultSeverity: Severity = 'error'): Parser => (stdout, stderr, where) => {
  const out: Diagnostic[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const row = line.replace(/^(?:vet|go): /, '').match(/^([^\s:][^:]*?):(\d+)(?::(\d+))?:\s*(?:(error|warning)(?:\[\w+\])?:\s*)?(.+)$/)
    if (!row || /^\d+ (warnings?|errors?) emitted/.test(row[5]!) || row[1]!.startsWith('#')) continue
    const rule = row[5]!.match(/\(([\w.-]+)\)$/)?.[1] ?? row[5]!.match(/^([A-Z]\d{2,4})\s/)?.[1] ?? null
    out.push(make(tool, where, row[1]!, Number(row[2]), row[3] ? Number(row[3]) : null, row[5]!.replace(/^[A-Z]\d{2,4}\s/, ''), rule, (row[4] as Severity | undefined) ?? defaultSeverity))
  }
  return out
}

/** Tries the formatters a project script may print, in order of specificity. */
export const script = (fallbackTool: string): Parser => (stdout, stderr, where) => {
  const found: Diagnostic[] = []
  const json = eslintJson(stdout, stderr, where)
  if (json?.length) found.push(...json)
  for (const parser of [tsc, eslintStylish, prettier, githubAnnotations('biome'), mypy, ruffFormat, black]) {
    const out = parser(stdout, stderr, where)
    if (out?.length) found.push(...out)
  }
  if (!found.length) {
    const generic = colonLines(fallbackTool)(stdout, stderr, where)
    if (generic?.length) found.push(...generic)
  }
  return found
}
