// Notion markdown (what /pages/{id}/markdown and the Notion MCP return) to plain markdown, and
// plain markdown to Notion API blocks. Both directions are deterministic, and nothing is dropped
// silently: a block the plain form cannot hold becomes an html comment naming its type. Pure, no
// node imports, so it is unit tested without a runtime.

export type Annotations = { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean; color?: string }
export type RichText = {
  type: 'text' | 'mention' | 'equation'
  text: { content: string; link?: { url: string } | null }
  annotations?: Annotations
  plain_text?: string
  href?: string | null
  equation?: { expression?: string }
}
/** A Notion API block as sent to or read from the blocks endpoints. `children` nests blocks the same way. */
export type Block = { object?: 'block'; id?: string; type: string; children?: Block[]; [key: string]: unknown }

/** Notion caps one rich text object at 2000 characters. */
export const RICH_TEXT_LIMIT = 2000

/** Items of one family stay on consecutive lines; a change of family (dashes to numbers) needs a blank line. */
function listFamily(type: string): 'dashes' | 'numbers' | undefined {
  if (type === 'bulleted_list_item' || type === 'to_do') return 'dashes'
  if (type === 'numbered_list_item') return 'numbers'
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Notion markdown to plain markdown
// ---------------------------------------------------------------------------------------------

type Chunk = { text: string; kind: 'dashes' | 'numbers' | 'other' }

const ATTRIBUTES = /\s*\{(?:\s*[a-z-]+="[^"]*")+\s*\}\s*$/
const LEAF_TAGS = ['file', 'video', 'pdf', 'audio', 'embed', 'database', 'folder', 'unknown', 'custom-block', 'table_of_contents', 'mention-database', 'mention-data-source']
const WRAPPER_TAGS = ['details', 'columns', 'tabs', 'synced_block', 'synced_block_reference', 'meeting-notes']

function unescapeOutsideCode(text: string): string {
  return text
    .split(/(`+[\s\S]*?`+)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\\([!-/:-@[-`{-~])/g, '$1')))
    .join('')
}

/** Inline Notion markup to plain markdown: mentions to links, spans to their text, escapes removed. */
function inline(text: string): string {
  const out = text
    .replace(/<mention-date\s+([^>]*?)\/>/g, (_m, attrs: string) => {
      const attr = (name: string) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1]
      const at = (date: string | undefined, time: string | undefined) => (date === undefined ? '' : time === undefined ? date : `${date} ${time}`)
      const end = at(attr('end'), attr('endTime'))
      return end === '' ? at(attr('start'), attr('startTime')) : `${at(attr('start'), attr('startTime'))} to ${end}`
    })
    .replace(/<(?:mention-(?:page|user|database|data-source|agent)|page) url="([^"]+)">([^<]*)<\/(?:mention-(?:page|user|database|data-source|agent)|page)>/g, (_m, url: string, title: string) => `[${title.trim() || url}](${url})`)
    .replace(/<mention-(?:page|user|database|data-source|agent) url="([^"]+)"\s*\/>/g, (_m, url: string) => `[${url}](${url})`)
    .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/g, '$1')
  return unescapeOutsideCode(out)
}

function comment(type: string, raw?: string): string {
  const body = raw === undefined ? '' : `: ${raw.replace(/--/g, '- -').trim()}`
  return `<!-- notion ${type}${body} -->`
}

function tableToPipes(lines: string[]): string {
  const html = lines.join('\n')
  const header = /<table\b[^>]*header-row="true"/.test(html)
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => inline(cell[1]!.trim()).replace(/\|/g, '\\|').replace(/\n/g, ' ')))
  const width = Math.max(1, ...rows.map((row) => row.length))
  const pad = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => '')]
  const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
  const head = header && rows.length > 0 ? rows[0]! : Array.from({ length: width }, () => '')
  const body = header ? rows.slice(1) : rows
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}

/** Lines until the closing tag of a block opened on `start`, with the index after it. Unclosed blocks run to the end. */
function enclosed(lines: string[], start: number, tag: string): { inner: string[]; next: number } {
  const close = new RegExp(`^\\s*</${tag}>\\s*$`)
  const open = new RegExp(`^\\s*<${tag}\\b`)
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (open.test(line) && !/\/>\s*$/.test(line) && !new RegExp(`</${tag}>\\s*$`).test(line)) depth += 1
    if (close.test(line)) {
      depth -= 1
      if (depth === 0) return { inner: lines.slice(start + 1, i), next: i + 1 }
    }
  }
  return { inner: lines.slice(start + 1), next: lines.length }
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.match(/^\t*/)![0].length)
  const least = indents.length === 0 ? 0 : Math.min(...indents)
  return lines.map((line) => line.slice(Math.min(least, line.match(/^\t*/)![0].length)))
}

function convertLines(lines: string[]): Chunk[] {
  const chunks: Chunk[] = []
  const push = (text: string, kind: Chunk['kind'] = 'other') => chunks.push({ text, kind })
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const tabs = raw.match(/^\t*/)![0].length
    const line = raw.slice(tabs)
    const last = chunks.at(-1)
    // Nested content: list children keep their nesting; anything else is flattened to the top level.
    if (tabs > 0 && last !== undefined && last.kind !== 'other' && !/^(- \[[ xX]\] |- |\d+\. )/.test(line)) {
      if (line.trim() !== '') push(`${'  '.repeat(tabs)}${inline(line.replace(ATTRIBUTES, '')).replace(/<br>/g, `\n${'  '.repeat(tabs + 1)}`)}`, last.kind)
      i += 1
      continue
    }
    if (line.trim() === '' || /^<empty-block\s*\/>$/.test(line.trim())) {
      i += 1
      continue
    }
    if (/^```/.test(line)) {
      const end = lines.findIndex((candidate, index) => index > i && candidate.trim() === '```')
      const stop = end === -1 ? lines.length : end + 1
      push(lines.slice(i, stop).map((l) => l.slice(Math.min(tabs, l.match(/^\t*/)![0].length))).join('\n'))
      i = stop
      continue
    }
    if (/^\$\$\s*$/.test(line)) {
      const end = lines.findIndex((candidate, index) => index > i && candidate.trim() === '$$')
      const stop = end === -1 ? lines.length : end + 1
      push(lines.slice(i, stop).join('\n'))
      i = stop
      continue
    }
    if (/^<table\b/.test(line)) {
      const { inner, next } = enclosed(lines, i, 'table')
      push(tableToPipes([line, ...inner]))
      i = next
      continue
    }
    if (/^<callout\b/.test(line)) {
      const { inner, next } = enclosed(lines, i, 'callout')
      const quoted = dedent(inner)
        .flatMap((l) => inline(l.replace(ATTRIBUTES, '')).split('<br>'))
        .filter((l) => l.trim() !== '')
        .map((l) => `> ${l.replace(/^\t+/, '')}`)
      push(quoted.join('\n'))
      i = next
      continue
    }
    const wrapper = WRAPPER_TAGS.find((tag) => new RegExp(`^<${tag}\\b`).test(line))
    if (wrapper !== undefined && !/\/>\s*$/.test(line)) {
      const { inner, next } = enclosed(lines, i, wrapper)
      push(comment(wrapper))
      const body: string[] = []
      for (const l of dedent(inner)) {
        const summary = l.match(/^<summary>([\s\S]*)<\/summary>$/)
        if (summary) body.push(`**${summary[1]!.trim()}**`)
        else if (/^<\/?(column|tab|summary|notes|transcript)\b[^>]*>$/.test(l.trim())) continue
        else body.push(l)
      }
      chunks.push(...convertLines(dedent(body)))
      i = next
      continue
    }
    const leaf = LEAF_TAGS.find((tag) => new RegExp(`^<${tag}\\b`).test(line))
    if (leaf !== undefined) {
      if (/\/>\s*$/.test(line) || new RegExp(`</${leaf}>\\s*$`).test(line)) {
        push(comment(leaf, line))
        i += 1
      } else {
        const { inner, next } = enclosed(lines, i, leaf)
        push(comment(leaf, [line, ...inner, `</${leaf}>`].join(' ')))
        i = next
      }
      continue
    }
    const heading = line.match(/^(#{1,6}) (.*)$/)
    if (heading) {
      push(`${heading[1]} ${inline(heading[2]!.replace(ATTRIBUTES, '')).replace(/<br>/g, ' ')}`)
      i += 1
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      push(
        inline(quote[1]!.replace(ATTRIBUTES, ''))
          .split('<br>')
          .map((l) => `> ${l}`)
          .join('\n'),
      )
      i += 1
      continue
    }
    const item = line.match(/^(- \[[ xX]\] |- |\d+\. )(.*)$/)
    if (item) {
      const indent = '  '.repeat(tabs)
      const kind = /^\d/.test(item[1]!) ? 'numbers' : 'dashes'
      push(`${indent}${item[1]}${inline(item[2]!.replace(ATTRIBUTES, '')).replace(/<br>/g, `\n${indent}  `)}`, tabs > 0 && last !== undefined && last.kind !== 'other' ? last.kind : kind)
      i += 1
      continue
    }
    if (/^---\s*$/.test(line)) {
      push('---')
      i += 1
      continue
    }
    push(inline(line.replace(ATTRIBUTES, '')).replace(/<br>/g, '\n'))
    i += 1
  }
  return chunks
}

/** Notion markdown to plain markdown. Blocks are separated by a blank line, list items stay together. */
export function notionToMarkdown(notion: string): string {
  const chunks = convertLines(notion.replace(/\r\n?/g, '\n').split('\n'))
  let out = ''
  chunks.forEach((chunk, index) => {
    const previous = chunks[index - 1]
    if (previous !== undefined) out += previous.kind !== 'other' && previous.kind === chunk.kind ? '\n' : '\n\n'
    out += chunk.text
  })
  return out === '' ? '' : `${out}\n`
}

// ---------------------------------------------------------------------------------------------
// Inline markdown to rich text, and back
// ---------------------------------------------------------------------------------------------

type Style = { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean; link?: string }

function run(content: string, style: Style): RichText {
  const annotations: Annotations = {}
  if (style.bold) annotations.bold = true
  if (style.italic) annotations.italic = true
  if (style.strikethrough) annotations.strikethrough = true
  if (style.code) annotations.code = true
  const text: RichText['text'] = { content }
  if (style.link !== undefined) text.link = { url: style.link }
  const rich: RichText = { type: 'text', text }
  if (Object.keys(annotations).length > 0) rich.annotations = annotations
  return rich
}

/** The index of `delimiter` at or after `from`, outside code spans, or -1. */
function findClose(s: string, from: number, delimiter: string): number {
  let i = from
  while (i < s.length) {
    if (s[i] === '`') {
      const span = /^(`+)[\s\S]*?\1(?!`)/.exec(s.slice(i))
      if (span) {
        i += span[0].length
        continue
      }
    }
    if (s.startsWith(delimiter, i)) {
      const single = delimiter.length === 1
      if (!single || (s[i + 1] !== delimiter && s[i - 1] !== delimiter)) return i
    }
    i += 1
  }
  return -1
}

/** `[text](url)` at `i`: the text (brackets balanced one level), the url (no whitespace), and the length consumed. */
function matchLink(s: string, i: number): { text: string; url: string; length: number } | undefined {
  let depth = 0
  let j = i
  while (j < s.length) {
    const ch = s[j]
    if (ch === '`') {
      const span = /^(`+)[\s\S]*?\1(?!`)/.exec(s.slice(j))
      if (span) {
        j += span[0].length
        continue
      }
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) break
    }
    j += 1
  }
  if (j >= s.length || s[j + 1] !== '(') return undefined
  let k = j + 2
  let parens = 0
  while (k < s.length) {
    const ch = s[k]!
    if (/\s/.test(ch)) return undefined
    if (ch === '(') parens += 1
    else if (ch === ')') {
      if (parens === 0) break
      parens -= 1
    }
    k += 1
  }
  if (k >= s.length) return undefined
  return { text: s.slice(i + 1, j), url: s.slice(j + 2, k), length: k + 1 - i }
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)

function scan(s: string, style: Style): RichText[] {
  const out: RichText[] = []
  let buffer = ''
  const flush = () => {
    if (buffer !== '') out.push(run(buffer, style))
    buffer = ''
  }
  let i = 0
  outer: while (i < s.length) {
    const ch = s[i]!
    if (ch === '`') {
      const span = /^(`+)([\s\S]*?)\1(?!`)/.exec(s.slice(i))
      if (span && span[2] !== '') {
        flush()
        const content = span[1]!.length > 1 && span[2]!.startsWith(' ') && span[2]!.endsWith(' ') ? span[2]!.slice(1, -1) : span[2]!
        out.push(run(content, { ...style, code: true }))
        i += span[0].length
        continue
      }
    }
    if (ch === '[') {
      const link = matchLink(s, i)
      if (link) {
        flush()
        out.push(...scan(link.text, { ...style, link: link.url }))
        i += link.length
        continue
      }
    }
    if (s.startsWith('***', i)) {
      const end = findClose(s, i + 3, '***')
      if (end > i + 3) {
        flush()
        out.push(...scan(s.slice(i + 3, end), { ...style, bold: true, italic: true }))
        i = end + 3
        continue
      }
    }
    for (const [delimiter, key] of [
      ['**', 'bold'],
      ['~~', 'strikethrough'],
    ] as const) {
      if (s.startsWith(delimiter, i)) {
        const end = findClose(s, i + 2, delimiter)
        if (end > i + 2) {
          flush()
          out.push(...scan(s.slice(i + 2, end), { ...style, [key]: true }))
          i = end + 2
          continue outer
        }
      }
    }
    if ((ch === '*' && !s.startsWith('**', i)) || (ch === '_' && !isWord(s[i - 1]))) {
      const end = findClose(s, i + 1, ch)
      const closes = end > i + 1 && s[i + 1] !== ' ' && s[end - 1] !== ' ' && (ch === '*' || !isWord(s[end + 1]))
      if (closes) {
        flush()
        out.push(...scan(s.slice(i + 1, end), { ...style, italic: true }))
        i = end + 1
        continue
      }
    }
    buffer += ch
    i += 1
  }
  flush()
  return out
}

const sameStyle = (a: RichText, b: RichText) => JSON.stringify([a.annotations ?? {}, a.text.link ?? null]) === JSON.stringify([b.annotations ?? {}, b.text.link ?? null])

/** Rich text objects for the Notion API, chunked at Notion's 2000 character limit. */
export function chunkText(content: string, template: RichText = { type: 'text', text: { content: '' } }): RichText[] {
  const out: RichText[] = []
  for (let i = 0; i < content.length || (i === 0 && content === ''); i += RICH_TEXT_LIMIT) {
    const piece = structuredClone(template)
    piece.text = { ...piece.text, content: content.slice(i, i + RICH_TEXT_LIMIT) }
    out.push(piece)
    if (content === '') break
  }
  return out
}

/** Plain markdown inline text (bold, italic, strikethrough, inline code, links) as Notion rich text. */
export function parseInline(text: string): RichText[] {
  const merged: RichText[] = []
  for (const piece of scan(text, {})) {
    const last = merged.at(-1)
    if (last !== undefined && sameStyle(last, piece) && !piece.annotations?.code) last.text.content += piece.text.content
    else merged.push(piece)
  }
  return merged.flatMap((piece) => chunkText(piece.text.content, piece))
}

type Wrapper = { key: 'link' | 'bold' | 'italic' | 'strikethrough'; value: string | true }

function wrapperOf(rich: RichText): Wrapper | undefined {
  if (rich.text.link?.url !== undefined) return { key: 'link', value: rich.text.link.url }
  if (rich.annotations?.bold) return { key: 'bold', value: true }
  if (rich.annotations?.italic) return { key: 'italic', value: true }
  if (rich.annotations?.strikethrough) return { key: 'strikethrough', value: true }
  return undefined
}

function shares(rich: RichText, wrapper: Wrapper): boolean {
  return wrapper.key === 'link' ? rich.text.link?.url === wrapper.value : rich.annotations?.[wrapper.key] === true
}

function without(rich: RichText, wrapper: Wrapper): RichText {
  const copy = structuredClone(rich)
  if (wrapper.key === 'link') delete copy.text.link
  else if (copy.annotations) delete copy.annotations[wrapper.key]
  return copy
}

function leaf(rich: RichText): string {
  if (rich.type === 'mention') return rich.href ? `[${rich.plain_text ?? rich.href}](${rich.href})` : (rich.plain_text ?? '')
  if (rich.type === 'equation') return `$\`${rich.equation?.expression ?? rich.plain_text ?? ''}\`$`
  const content = rich.text.content
  if (!rich.annotations?.code) return content
  const fence = content.includes('`') ? '``' : '`'
  const padded = content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content
  return `${fence}${padded}${fence}`
}

/** Rich text back to plain markdown in one canonical form: links outermost, then bold, italic, strikethrough. */
export function richTextToMarkdown(rich: RichText[]): string {
  let out = ''
  let i = 0
  while (i < rich.length) {
    const first = rich[i]!
    const wrapper = first.type === 'text' ? wrapperOf(first) : undefined
    if (wrapper === undefined) {
      out += leaf(first)
      i += 1
      continue
    }
    let j = i
    while (j < rich.length && rich[j]!.type === 'text' && shares(rich[j]!, wrapper)) j += 1
    const inner = richTextToMarkdown(rich.slice(i, j).map((piece) => without(piece, wrapper)))
    const mark = { bold: '**', italic: '*', strikethrough: '~~' }
    out += wrapper.key === 'link' ? `[${inner}](${wrapper.value})` : `${mark[wrapper.key]}${inner}${mark[wrapper.key]}`
    i = j
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Plain markdown to Notion blocks
// ---------------------------------------------------------------------------------------------

/** The languages Notion's code block accepts, as the API spells them. */
const LANGUAGES = new Set(
  'abap|agda|arduino|ascii art|assembly|bash|basic|bnf|c|c#|c++|clojure|coffeescript|coq|css|dart|dhall|diff|docker|ebnf|elixir|elm|erlang|f#|flow|fortran|gherkin|glsl|go|graphql|groovy|haskell|hcl|html|idris|java|javascript|json|julia|kotlin|latex|less|lisp|livescript|llvm ir|lua|makefile|markdown|markup|matlab|mathematica|mermaid|nix|notion formula|objective-c|ocaml|pascal|perl|php|plain text|powershell|prolog|protobuf|purescript|python|r|racket|reason|ruby|rust|sass|scala|scheme|scss|shell|smalltalk|solidity|sql|swift|toml|typescript|vb.net|verilog|vhdl|visual basic|webassembly|xml|yaml'.split('|'),
)
const LANGUAGE_ALIASES: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', sh: 'shell', zsh: 'shell', yml: 'yaml', md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', cs: 'c#', cpp: 'c++', text: 'plain text', txt: 'plain text', '': 'plain text' }

export function codeLanguage(fence: string): string {
  const name = fence.trim().toLowerCase()
  const mapped = LANGUAGE_ALIASES[name] ?? name
  return LANGUAGES.has(mapped) ? mapped : 'plain text'
}

const indentWidth = (line: string) => line.match(/^[ \t]*/)![0].replace(/\t/g, '  ').length
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitCells(line: string): string[] {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
  return cells
}

function block(type: string, body: Record<string, unknown>): Block {
  return { object: 'block', type, [type]: body }
}

/** Plain markdown to Notion API blocks: headings 1-3, paragraphs, lists, to-dos, code, tables, quotes, dividers. */
export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const root: Block[] = []
  const stack: { indent: number; block: Block }[] = []
  let paragraph: { block: Block; container: Block[] } | undefined

  // The list of blocks a line at this indent belongs to: the children of the nearest open list
  // item with a smaller indent, or the top level.
  const containerFor = (indent: number): Block[] => {
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop()
    const top = stack.at(-1)
    if (top === undefined) return root
    top.block.children ??= []
    return top.block.children
  }

  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const line = raw.trimStart()
    const indent = indentWidth(raw)
    if (line.trim() === '') {
      paragraph = undefined
      i += 1
      continue
    }
    const fence = line.match(/^(`{3,}|~{3,})\s*([^`\s]*)\s*$/)
    if (fence) {
      paragraph = undefined
      const marker = fence[1]!
      let end = i + 1
      while (end < lines.length && !(lines[end]!.trimStart().startsWith(marker[0]!.repeat(marker.length)) && lines[end]!.trim().replace(new RegExp(`^${marker[0]}+`), '') === '')) end += 1
      const prefix = raw.slice(0, raw.length - line.length)
      const content = lines.slice(i + 1, end).map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l.trimStart()))
      containerFor(indent).push(block('code', { language: codeLanguage(fence[2]!), rich_text: chunkText(content.join('\n')) }))
      i = end + 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      paragraph = undefined
      const level = Math.min(3, heading[1]!.length)
      containerFor(indent).push(block(`heading_${level}`, { rich_text: parseInline(heading[2]!) }))
      i += 1
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      paragraph = undefined
      containerFor(indent).push(block('divider', {}))
      i += 1
      continue
    }
    if (line.startsWith('|') && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      paragraph = undefined
      const rows: string[][] = [splitCells(line)]
      let end = i + 2
      while (end < lines.length && lines[end]!.trimStart().startsWith('|')) {
        rows.push(splitCells(lines[end]!))
        end += 1
      }
      const width = Math.max(...rows.map((row) => row.length))
      const hasHeader = rows[0]!.some((cell) => cell !== '')
      const body = hasHeader ? rows : rows.slice(1)
      const children = body.map((row) => block('table_row', { cells: [...row, ...Array.from({ length: width - row.length }, () => '')].map((cell) => parseInline(cell)) }))
      containerFor(indent).push({ ...block('table', { table_width: width, has_column_header: hasHeader, has_row_header: false }), children })
      i = end
      continue
    }
    if (line.startsWith('>')) {
      paragraph = undefined
      const quoted: string[] = []
      let end = i
      while (end < lines.length && lines[end]!.trimStart().startsWith('>')) {
        quoted.push(lines[end]!.trimStart().replace(/^>\s?/, ''))
        end += 1
      }
      containerFor(indent).push(block('quote', { rich_text: parseInline(quoted.join('\n')) }))
      i = end
      continue
    }
    const item = line.match(/^([-*+]|\d+[.)])\s+(.*)$/)
    if (item) {
      paragraph = undefined
      const container = containerFor(indent)
      const todo = item[2]!.match(/^\[([ xX])\]\s+(.*)$/)
      const made = todo
        ? block('to_do', { rich_text: parseInline(todo[2]!), checked: todo[1] !== ' ' })
        : /\d/.test(item[1]!)
          ? block('numbered_list_item', { rich_text: parseInline(item[2]!) })
          : block('bulleted_list_item', { rich_text: parseInline(item[2]!) })
      container.push(made)
      stack.push({ indent, block: made })
      i += 1
      continue
    }
    const container = containerFor(indent)
    if (paragraph !== undefined && paragraph.container === container) {
      const body = paragraph.block.paragraph as { rich_text: RichText[] }
      body.rich_text = parseInline(`${richTextToMarkdown(body.rich_text)}\n${line}`)
    } else {
      const made = block('paragraph', { rich_text: parseInline(line) })
      container.push(made)
      paragraph = { block: made, container }
    }
    i += 1
  }
  return root
}

// ---------------------------------------------------------------------------------------------
// Notion blocks to plain markdown
// ---------------------------------------------------------------------------------------------

function richOf(blk: Block): RichText[] {
  const body = blk[blk.type] as { rich_text?: RichText[] } | undefined
  return body?.rich_text ?? []
}

function renderBlock(blk: Block, number: number): string {
  const text = richTextToMarkdown(richOf(blk))
  switch (blk.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return `${'#'.repeat(Number(blk.type.slice(-1)))} ${text}`
    case 'paragraph':
      return text
    case 'bulleted_list_item':
      return `- ${text}`
    case 'numbered_list_item':
      return `${number}. ${text}`
    case 'to_do':
      return `- [${(blk.to_do as { checked?: boolean }).checked ? 'x' : ' '}] ${text}`
    case 'quote':
    case 'callout':
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'code': {
      const language = (blk.code as { language?: string }).language ?? 'plain text'
      return `\`\`\`${language === 'plain text' ? '' : language}\n${richOf(blk)
        .map((piece) => piece.text.content)
        .join('')}\n\`\`\``
    }
    case 'divider':
      return '---'
    case 'image': {
      const image = blk.image as { external?: { url?: string }; file?: { url?: string }; caption?: RichText[] }
      return `![${richTextToMarkdown(image.caption ?? [])}](${image.external?.url ?? image.file?.url ?? ''})`
    }
    case 'table': {
      const table = blk.table as { table_width?: number; has_column_header?: boolean }
      const rows = (blk.children ?? []).map((row) => ((row.table_row as { cells?: RichText[][] }).cells ?? []).map((cell) => richTextToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')))
      const width = table.table_width ?? Math.max(1, ...rows.map((row) => row.length))
      const line = (row: string[]) => `| ${[...row, ...Array.from({ length: width - row.length }, () => '')].join(' | ')} |`
      const head = table.has_column_header === false || rows.length === 0 ? Array.from({ length: width }, () => '') : rows[0]!
      const body = table.has_column_header === false ? rows : rows.slice(1)
      return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
    }
    case 'child_page':
      return comment('child_page', (blk.child_page as { title?: string }).title)
    default:
      return comment(blk.type)
  }
}

function renderBlocks(blocks: Block[], depth: number): string {
  const indent = '  '.repeat(depth)
  let out = ''
  let number = 0
  blocks.forEach((blk, index) => {
    number = blk.type === 'numbered_list_item' ? number + 1 : 0
    const previous = blocks[index - 1]
    // Nested under a list item everything stays on consecutive lines; at the top level a change of list family needs a blank line.
    if (previous !== undefined) out += depth > 0 || (listFamily(previous.type) !== undefined && listFamily(previous.type) === listFamily(blk.type)) ? '\n' : '\n\n'
    out += renderBlock(blk, number)
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n')
    if (blk.type !== 'table' && blk.children && blk.children.length > 0) out += `\n${renderBlocks(blk.children, depth + 1)}`
  })
  return out
}

/** Notion API blocks (as `markdownToBlocks` makes them, or as the blocks endpoint returns them) to plain markdown. */
export function blocksToMarkdown(blocks: Block[]): string {
  const out = renderBlocks(blocks, 0)
  return out === '' ? '' : `${out}\n`
}
