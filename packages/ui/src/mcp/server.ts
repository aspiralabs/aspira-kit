// MCP server over this package's own docs. Ships in the package, reads from the
// installed copy, so an agent gets the docs for the version it has installed.
// Five tools, no database.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..', '..')
const docsDir = join(pkgRoot, 'docs')
const patternsDir = join(docsDir, 'patterns')
const tokensPath = join(pkgRoot, 'tokens.css')
const version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version as string

type Doc = { name: string; title: string; description: string; body: string; raw: string }

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

function loadDocs(dir: string): Doc[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const { fields, body } = frontmatter(raw)
      const name = f.replace(/\.mdx$/, '')
      return { name, title: fields.title ?? name, description: fields.description ?? '', body, raw }
    })
}

function section(body: string, heading: string): string | undefined {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')
  return body.match(re)?.[1]?.trim()
}

const server = new McpServer({ name: 'aspiralabs-ui', version })

server.registerTool(
  'list_components',
  {
    description: 'List every component in @aspiralabs/ui with its one-line description and import path. Call this first when you are unsure which component to use.',
    inputSchema: {},
  },
  async () => {
    const docs = loadDocs(docsDir)
    const text = docs.map((d) => `- ${d.title}: ${d.description}`).join('\n')
    return { content: [{ type: 'text', text: `@aspiralabs/ui ${version}\n\n${text || '(no docs yet)'}` }] }
  },
)

server.registerTool(
  'get_component',
  {
    description: 'Get the docs for one component: usage, variants, sizes, states, props. Call this before writing or editing any component markup.',
    inputSchema: { name: z.string().describe('Component name as in list_components, e.g. "button"'), section: z.enum(['all', 'usage', 'props']).default('all') },
  },
  async ({ name, section: which }) => {
    const doc = loadDocs(docsDir).find((d) => d.name === name.toLowerCase())
    if (!doc) {
      return { content: [{ type: 'text', text: `No component named "${name}". Call list_components.` }], isError: true }
    }
    if (which === 'all') {
      return { content: [{ type: 'text', text: doc.raw }] }
    }
    const heading = which === 'usage' ? 'Usage' : 'Props'
    return { content: [{ type: 'text', text: section(doc.body, heading) ?? `(no ${heading} section)` }] }
  },
)

server.registerTool(
  'search',
  {
    description: 'Search component docs and patterns for a word or phrase. Returns matching lines with the component name.',
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const q = query.toLowerCase()
    const hits: string[] = []
    for (const d of [...loadDocs(docsDir), ...loadDocs(patternsDir)]) {
      d.raw.split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(q)) {
          hits.push(`${d.name}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    return { content: [{ type: 'text', text: hits.length ? hits.slice(0, 50).join('\n') : '(no matches)' }] }
  },
)

server.registerTool(
  'get_tokens',
  {
    description: 'Get the design tokens (CSS variables) with their default values and the override contract. Use these instead of palette colors.',
    inputSchema: {},
  },
  async () => {
    const css = readFileSync(tokensPath, 'utf8')
    return { content: [{ type: 'text', text: css }] }
  },
)

server.registerTool(
  'get_pattern',
  {
    description: 'Get a layout pattern doc (page anatomy, section, toolbar, table actions). Omit name to list patterns.',
    inputSchema: { name: z.string().optional() },
  },
  async ({ name }) => {
    const docs = loadDocs(patternsDir)
    if (!name) {
      return { content: [{ type: 'text', text: docs.map((d) => `- ${d.name}: ${d.description}`).join('\n') || '(no patterns yet)' }] }
    }
    const doc = docs.find((d) => d.name === name.toLowerCase())
    if (!doc) {
      return { content: [{ type: 'text', text: `No pattern named "${name}".` }], isError: true }
    }
    return { content: [{ type: 'text', text: doc.raw }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
