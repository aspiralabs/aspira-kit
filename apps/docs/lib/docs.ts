// Reads the docs that ship inside @aspiralabs/ui. The docs site is a renderer
// of the package's MDX, never a second copy of it. The nav is derived from
// frontmatter, so adding a doc to the package adds it to the site.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type View = 'components' | 'patterns' | 'overview'
export const VIEWS: Array<{ id: View; label: string; dir: string }> = [
  { id: 'overview', label: 'Overview', dir: 'overview' },
  { id: 'components', label: 'Components', dir: '.' },
  { id: 'patterns', label: 'Layout Patterns', dir: 'patterns' },
]

export type Doc = {
  view: View
  slug: string
  eyebrow: string
  title: string
  group: string
  description: string
  body: string
  raw: string
}

export type NavGroup = { group: string; items: Array<{ slug: string; label: string }> }

const GROUP_ORDER = ['Foundations', 'Surfaces', 'Actionable', 'Form', 'Tables', 'Overlays', 'Layout', 'Misc', 'Page Chrome', 'Marketing']

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

export function uiVersion(): string {
  return (JSON.parse(readFileSync(join(uiPackageRoot(), 'package.json'), 'utf8')) as { version: string }).version
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

export function listDocs(view: View): Doc[] {
  const meta = VIEWS.find((v) => v.id === view)!
  const dir = join(uiPackageRoot(), 'docs', meta.dir)
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const { fields, body } = frontmatter(raw)
      const slug = f.replace(/\.mdx$/, '')
      return {
        view,
        slug,
        eyebrow: fields.eyebrow ?? '',
        title: fields.title ?? slug,
        group: fields.group ?? 'Misc',
        description: fields.description ?? '',
        body,
        raw,
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title))
}

export function getDoc(view: View, slug: string): Doc | undefined {
  return listDocs(view).find((d) => d.slug === slug)
}

// Sidebar labels: PascalCase titles get spaces (KeyboardShortcut -> Keyboard Shortcut); titles with
// spaces or dashes are left alone. SAAS_BOILER hardcoded these labels; here they derive from the title.
function navLabel(title: string): string {
  if (/[\s-]/.test(title)) {
    return title
  }
  return title.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

export function navFor(view: View): NavGroup[] {
  const groups = new Map<string, NavGroup>()
  for (const doc of listDocs(view)) {
    const g = groups.get(doc.group) ?? { group: doc.group, items: [] }
    g.items.push({ slug: doc.slug, label: navLabel(doc.title) })
    groups.set(doc.group, g)
  }
  return [...groups.values()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.group)
    const bi = GROUP_ORDER.indexOf(b.group)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
}

export function firstSlug(view: View): string | undefined {
  return navFor(view)[0]?.items[0]?.slug
}
