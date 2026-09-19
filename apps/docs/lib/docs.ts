// Reads the component docs from the installed @aspiralabs/ui package. The docs
// site is a renderer of the package's MDX, never a second copy of it.
// Resolves the package by walking up from cwd to node_modules, which works
// under Turbopack where import.meta.url is rewritten.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ComponentDoc = { name: string; title: string; description: string; body: string }

export function uiPackageRoot(): string {
  let dir = process.cwd()
  while (true) {
    const candidate = join(dir, 'node_modules', '@aspiralabs', 'ui')
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('@aspiralabs/ui is not installed')
    }
    dir = parent
  }
}

function frontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) {
    return { fields: {}, body: raw }
  }
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return { fields, body: m[2]! }
}

export function listDocs(): ComponentDoc[] {
  const dir = join(uiPackageRoot(), 'docs')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => {
      const { fields, body } = frontmatter(readFileSync(join(dir, f), 'utf8'))
      const name = f.replace(/\.mdx$/, '')
      return { name, title: fields.title ?? name, description: fields.description ?? '', body }
    })
}

export function uiVersion(): string {
  return (JSON.parse(readFileSync(join(uiPackageRoot(), 'package.json'), 'utf8')) as { version: string }).version
}
