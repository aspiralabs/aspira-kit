import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blocksToMarkdown, markdownToBlocks, notionToMarkdown, parseInline, richTextToMarkdown, type Block } from './notion-markdown'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/notion/${name}`, import.meta.url), 'utf8')

/** The rich text of a block as plain markdown, for assertions on what a block says. */
function textOf(block: Block): string {
  const body = block[block.type] as { rich_text?: Parameters<typeof richTextToMarkdown>[0] } | undefined
  return richTextToMarkdown(body?.rich_text ?? [])
}

describe('notionToMarkdown', () => {
  it('unescapes the characters Notion escapes, outside fenced code only', () => {
    const notion = 'a \\* b \\_ c \\[d\\] \\{e\\} -\\> f \\| g\n```ts\nconst a = \\[1\\]\n```'
    expect(notionToMarkdown(notion)).toBe('a * b _ c [d] {e} -> f | g\n\n```ts\nconst a = \\[1\\]\n```\n')
  })

  it('turns an html table into a pipe table, header row first, with pipes in cells escaped', () => {
    const notion = `<table header-row="true">
<tr>
<td>Column</td>
<td>Moves on when</td>
</tr>
<tr>
<td>Idea</td>
<td>A | B → Grooming</td>
</tr>
</table>`
    expect(notionToMarkdown(notion)).toBe('| Column | Moves on when |\n| --- | --- |\n| Idea | A \\| B → Grooming |\n')
  })

  it('gives a table without a header row an empty header so the pipe table still parses', () => {
    const notion = '<table>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</table>'
    expect(notionToMarkdown(notion)).toBe('|  |  |\n| --- | --- |\n| a | b |\n')
  })

  it('turns a callout into a block quote and its <br> into quote lines', () => {
    const notion = '<callout icon="📌" color="gray_bg">\n\t**Purpose:** what.<br>**Rule ID prefix:** `TEST`\n\tSecond child\n</callout>\n## Rules'
    expect(notionToMarkdown(notion)).toBe('> **Purpose:** what.\n> **Rule ID prefix:** `TEST`\n> Second child\n\n## Rules\n')
  })

  it('turns mentions and child page tags into links, and date mentions into text', () => {
    const notion = [
      'See <mention-page url="https://app.notion.com/p/3e73e59b225881d99dd9d5e42e57031d">Git & Code Review</mention-page> and <mention-page url="https://app.notion.com/p/3e73e59b22588108be3efcc98273c657"/>.',
      'By <mention-user url="user://450eaf9b-b1e7-4a1d-85f7-b48fa2ad5f13">David</mention-user> on <mention-date start="2026-10-05" end="2026-10-06"/>.',
      '<page url="https://app.notion.com/p/3ec3e59b225881189d69d3151595999b">Spec</page>',
    ].join('\n')
    expect(notionToMarkdown(notion)).toBe(
      [
        'See [Git & Code Review](https://app.notion.com/p/3e73e59b225881d99dd9d5e42e57031d) and [https://app.notion.com/p/3e73e59b22588108be3efcc98273c657](https://app.notion.com/p/3e73e59b22588108be3efcc98273c657).',
        '',
        'By [David](user://450eaf9b-b1e7-4a1d-85f7-b48fa2ad5f13) on 2026-10-05 to 2026-10-06.',
        '',
        '[Spec](https://app.notion.com/p/3ec3e59b225881189d69d3151595999b)',
        '',
      ].join('\n'),
    )
  })

  it('names an unsupported block in an html comment instead of dropping it', () => {
    const notion = '<file src="notion-file-block://x?name=plan.md">[plan.md](http://plan.md)</file>\n<table_of_contents color="gray"/>\n<unknown url="https://app.notion.com/p/1" alt="Alt"/>\nText'
    expect(notionToMarkdown(notion)).toBe(
      '<!-- notion file: <file src="notion-file-block://x?name=plan.md">[plan.md](http://plan.md)</file> -->\n\n<!-- notion table_of_contents: <table_of_contents color="gray"/> -->\n\n<!-- notion unknown: <unknown url="https://app.notion.com/p/1" alt="Alt"/> -->\n\nText\n',
    )
  })

  it('keeps the content of toggles and columns, with the wrapper named in a comment', () => {
    const notion = '<details>\n<summary>More</summary>\nHidden text\n</details>\n<columns>\n\t<column ratio="50">\n\t\tLeft\n\t</column>\n\t<column>\n\t\tRight\n\t</column>\n</columns>'
    expect(notionToMarkdown(notion)).toBe('<!-- notion details -->\n\n**More**\n\nHidden text\n\n<!-- notion columns -->\n\nLeft\n\nRight\n')
  })

  it('strips block attribute lists, inline spans and empty blocks, and keeps headings and lists as they are', () => {
    const notion = '# Title {color="red"}\n## Toggle {toggle="true"}\n\tInside\n<span color="blue">blue</span> and <span underline="true">under</span>\n<empty-block/>\n- one\n\t- two {color="gray"}\n\t\t- three\n1. first\n2. second\n- [ ] todo\n- [x] done\n---'
    expect(notionToMarkdown(notion)).toBe('# Title\n\n## Toggle\n\nInside\n\nblue and under\n\n- one\n  - two\n    - three\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n\n---\n')
  })

  it('separates consecutive quotes with a blank line, and keeps a multi-line quote together', () => {
    expect(notionToMarkdown('> one\n> two\n> a<br>b')).toBe('> one\n\n> two\n\n> a\n> b\n')
  })

  it('is deterministic', () => {
    const plan = fixture('plan.notion.md')
    expect(notionToMarkdown(plan)).toBe(notionToMarkdown(plan))
  })
})

describe('parseInline and richTextToMarkdown', () => {
  it('reads bold, italic, strikethrough, inline code and links into rich text', () => {
    const runs = parseInline('plain **bold** *it* _it2_ ~~gone~~ `co[de]` [link **in**](https://x.y) end')
    expect(runs.map((r) => [r.text.content, r.annotations?.bold ?? false, r.annotations?.italic ?? false, r.annotations?.strikethrough ?? false, r.annotations?.code ?? false, r.text.link?.url])).toEqual([
      ['plain ', false, false, false, false, undefined],
      ['bold', true, false, false, false, undefined],
      [' ', false, false, false, false, undefined],
      ['it', false, true, false, false, undefined],
      [' ', false, false, false, false, undefined],
      ['it2', false, true, false, false, undefined],
      [' ', false, false, false, false, undefined],
      ['gone', false, false, true, false, undefined],
      [' ', false, false, false, false, undefined],
      ['co[de]', false, false, false, true, undefined],
      [' ', false, false, false, false, undefined],
      ['link ', false, false, false, false, 'https://x.y'],
      ['in', true, false, false, false, 'https://x.y'],
      [' end', false, false, false, false, undefined],
    ])
  })

  it('leaves unmatched markers, intraword underscores and a code span with brackets alone', () => {
    expect(richTextToMarkdown(parseInline('2 * 3 and SUPER_ADMIN and `a[b]` and [not a link]'))).toBe('2 * 3 and SUPER_ADMIN and `a[b]` and [not a link]')
    expect(parseInline('2 * 3 and SUPER_ADMIN').every((r) => !r.annotations)).toBe(true)
  })

  it('renders nested formatting back in one canonical form', () => {
    expect(richTextToMarkdown(parseInline('**see [here](u) now**'))).toBe('**see [here](u) now**')
    expect(richTextToMarkdown(parseInline('[**a** b](u)'))).toBe('[**a** b](u)')
    expect(richTextToMarkdown(parseInline('***both***'))).toBe('***both***')
    expect(richTextToMarkdown(parseInline('**bold `code`**'))).toBe('**bold `code`**')
  })

  it('splits text longer than the Notion limit of 2000 characters into runs', () => {
    const runs = parseInline('x'.repeat(4500))
    expect(runs.map((r) => r.text.content.length)).toEqual([2000, 2000, 500])
  })
})

describe('markdownToBlocks', () => {
  const only = (markdown: string) => {
    const blocks = markdownToBlocks(markdown)
    expect(blocks).toHaveLength(1)
    return blocks[0]!
  }

  it('makes headings 1 to 3 and folds deeper headings into heading 3', () => {
    expect(markdownToBlocks('# One\n## Two\n### Three\n#### Four').map((b) => [b.type, textOf(b)])).toEqual([
      ['heading_1', 'One'],
      ['heading_2', 'Two'],
      ['heading_3', 'Three'],
      ['heading_3', 'Four'],
    ])
  })

  it('joins consecutive lines into one paragraph and splits paragraphs on blank lines', () => {
    expect(markdownToBlocks('a\nb\n\nc').map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'a\nb'],
      ['paragraph', 'c'],
    ])
  })

  it('makes bulleted, numbered and to-do items with nested children', () => {
    const blocks = markdownToBlocks('- one\n  - two\n    - three\n  - two b\n- [ ] todo\n- [x] done\n1. first\n2. second\n   continued')
    expect(blocks.map((b) => [b.type, textOf(b)])).toEqual([
      ['bulleted_list_item', 'one'],
      ['to_do', 'todo'],
      ['to_do', 'done'],
      ['numbered_list_item', 'first'],
      ['numbered_list_item', 'second'],
    ])
    const one = blocks[0]!
    expect(one.children?.map((b) => [b.type, textOf(b)])).toEqual([
      ['bulleted_list_item', 'two'],
      ['bulleted_list_item', 'two b'],
    ])
    expect(one.children?.[0]?.children?.map((b) => textOf(b))).toEqual(['three'])
    expect((blocks[1]!.to_do as { checked: boolean }).checked).toBe(false)
    expect((blocks[2]!.to_do as { checked: boolean }).checked).toBe(true)
    expect(blocks[4]!.children?.map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'continued']])
  })

  it('keeps fenced code literal, maps the language and chunks long content', () => {
    const block = only('```ts\nconst a = [1, 2]\n**not bold**\n```')
    expect(block.type).toBe('code')
    const code = block.code as { language: string; rich_text: { text: { content: string } }[] }
    expect(code.language).toBe('typescript')
    expect(code.rich_text.map((r) => r.text.content).join('')).toBe('const a = [1, 2]\n**not bold**')
    expect((only('```\nplain\n```').code as { language: string }).language).toBe('plain text')
    expect((only('```nosuchlang\nx\n```').code as { language: string }).language).toBe('plain text')
    const long = only('```\n' + 'y'.repeat(4100) + '\n```').code as { rich_text: { text: { content: string } }[] }
    expect(long.rich_text.map((r) => r.text.content.length)).toEqual([2000, 2000, 100])
  })

  it('makes a table from a pipe table, unescaping pipes and padding short rows', () => {
    const block = only('| A | B |\n| --- | --- |\n| 1 \\| x | **2** |\n| only |')
    expect(block.type).toBe('table')
    expect(block.table).toEqual({ table_width: 2, has_column_header: true, has_row_header: false })
    const rows = block.children!.map((row) => (row.table_row as { cells: Parameters<typeof richTextToMarkdown>[0][] }).cells.map((cell) => richTextToMarkdown(cell)))
    expect(rows).toEqual([
      ['A', 'B'],
      ['1 | x', '**2**'],
      ['only', ''],
    ])
  })

  it('makes a quote from consecutive quote lines and a divider from a rule', () => {
    expect(markdownToBlocks('> a\n> b\n\n---').map((b) => [b.type, textOf(b)])).toEqual([
      ['quote', 'a\nb'],
      ['divider', ''],
    ])
  })

  it('keeps an html comment as a paragraph so nothing pushed is lost', () => {
    expect(only('<!-- notion file: x -->').type).toBe('paragraph')
  })

  it('ignores blank lines and is deterministic', () => {
    expect(markdownToBlocks('\n\n')).toEqual([])
    const plain = notionToMarkdown(fixture('spec-reviewed.notion.md'))
    expect(markdownToBlocks(plain)).toEqual(markdownToBlocks(plain))
  })
})

describe('blocksToMarkdown', () => {
  it('renders every supported block back to the markdown it was parsed from', () => {
    const markdown = [
      '# Title',
      '',
      'A paragraph with **bold**, *italic*, `code` and a [link](https://x.y).',
      'Second line of it.',
      '',
      '- one',
      '  - two',
      '    - three',
      '- [ ] todo',
      '- [x] done',
      '',
      '1. first',
      '2. second',
      '',
      '```typescript',
      'const a = [1]',
      '```',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 \\| x | 2 |',
      '',
      '> quoted',
      '> twice',
      '',
      '---',
      '',
    ].join('\n')
    expect(blocksToMarkdown(markdownToBlocks(markdown))).toBe(markdown)
  })

  it('names a block type it cannot render in an html comment', () => {
    expect(blocksToMarkdown([{ object: 'block', type: 'synced_block', synced_block: {} }])).toBe('<!-- notion synced_block -->\n')
  })
})

describe('round trip of the NOM-4 pages', () => {
  const headings = (notion: string) => notion.split('\n').filter((line) => /^#{1,3} /.test(line)).map((line) => line.replace(/^#+ /, ''))
  const items = (notion: string) => notion.split('\n').filter((line) => /^\t*(- |\d+\. )/.test(line)).length
  const collect = (blocks: Block[], into: Block[] = []): Block[] => {
    for (const block of blocks) {
      into.push(block)
      collect(block.children ?? [], into)
    }
    return into
  }

  for (const name of ['spec-reviewed.notion.md', 'plan.notion.md']) {
    it(`changes no heading, list item, table cell or code line of ${name}`, () => {
      const notion = fixture(name)
      const plain = notionToMarkdown(notion)
      const blocks = markdownToBlocks(plain)
      const all = collect(blocks)
      expect(all.filter((b) => b.type.startsWith('heading_')).map(textOf)).toEqual(headings(notion))
      expect(all.filter((b) => ['bulleted_list_item', 'numbered_list_item', 'to_do'].includes(b.type))).toHaveLength(items(notion))
      expect(all.filter((b) => b.type === 'to_do')).toHaveLength((notion.match(/^- \[[ x]\] /gm) ?? []).length)
      expect(blocksToMarkdown(blocks)).toBe(plain)
    })
  }

  it('keeps every cell and code line of a page with a table and code through the trip', () => {
    const notion = '## Rules\n<table header-row="true">\n<tr>\n<td>If the task involves</td>\n<td>Read</td>\n</tr>\n<tr>\n<td>Any code change</td>\n<td><mention-page url="https://app.notion.com/p/3e73e59b225881d99dd9d5e42e57031d"/>, <mention-page url="https://app.notion.com/p/3e73e59b22588108be3efcc98273c657"/></td>\n</tr>\n</table>\n```bash\npnpm test\npnpm lint\n```'
    const plain = notionToMarkdown(notion)
    const blocks = markdownToBlocks(plain)
    expect(blocksToMarkdown(blocks)).toBe(plain)
    const table = blocks[1]!
    const cells = table.children!.map((row) => (row.table_row as { cells: Parameters<typeof richTextToMarkdown>[0][] }).cells.map((cell) => richTextToMarkdown(cell)))
    expect(cells).toEqual([
      ['If the task involves', 'Read'],
      ['Any code change', '[https://app.notion.com/p/3e73e59b225881d99dd9d5e42e57031d](https://app.notion.com/p/3e73e59b225881d99dd9d5e42e57031d), [https://app.notion.com/p/3e73e59b22588108be3efcc98273c657](https://app.notion.com/p/3e73e59b22588108be3efcc98273c657)'],
    ])
    const code = blocks[2]!.code as { language: string; rich_text: { text: { content: string } }[] }
    expect(code.language).toBe('bash')
    expect(code.rich_text.map((r) => r.text.content).join('').split('\n')).toEqual(['pnpm test', 'pnpm lint'])
  })
})
