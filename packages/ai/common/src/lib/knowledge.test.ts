import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUIRED,
  KNOWLEDGE_PATH,
  REQUIRED_FILE,
  childPagesOf,
  fileFor,
  pageIdFrom,
  parseRequired,
  renderPage,
  renderRequired,
  resolveRequired,
  rewriteLinks,
  type LoadedPage,
} from './knowledge'

describe('pageIdFrom', () => {
  it('reads the id off a Notion URL with a title slug', () => {
    expect(pageIdFrom('https://www.notion.so/aspiralabs/Engineering-2f3a1b4c5d6e7f8091a2b3c4d5e6f708')).toBe(
      '2f3a1b4c-5d6e-7f80-91a2-b3c4d5e6f708',
    )
  })

  it('reads a dashed id, a bare id, and an id with a query string', () => {
    expect(pageIdFrom('2f3a1b4c-5d6e-7f80-91a2-b3c4d5e6f708')).toBe('2f3a1b4c-5d6e-7f80-91a2-b3c4d5e6f708')
    expect(pageIdFrom('2f3a1b4c5d6e7f8091a2b3c4d5e6f708')).toBe('2f3a1b4c-5d6e-7f80-91a2-b3c4d5e6f708')
    expect(pageIdFrom('https://notion.so/Engineering-2f3a1b4c5d6e7f8091a2b3c4d5e6f708?pvs=4')).toBe(
      '2f3a1b4c-5d6e-7f80-91a2-b3c4d5e6f708',
    )
  })

  it('returns undefined when there is no 32-hex id', () => {
    expect(pageIdFrom('https://www.notion.so/aspiralabs/Engineering')).toBeUndefined()
    expect(pageIdFrom('')).toBeUndefined()
  })
})

describe('childPagesOf', () => {
  const md = `# Engineering

<page url="https://www.notion.so/Agents-start-here-aaaaaaaabbbbccccddddeeeeeeeeeeee">Agents start here</page>
Some text.
<page url="https://www.notion.so/Pagination-11112222333344445555666677778888">Paginating a list endpoint</page>
<database url="https://www.notion.so/99998888777766665555444433332222">Decisions log</database>
`

  it('lists child page tags in document order with title and id', () => {
    expect(childPagesOf(md)).toEqual([
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Agents start here', url: 'https://www.notion.so/Agents-start-here-aaaaaaaabbbbccccddddeeeeeeeeeeee' },
      { id: '11112222-3333-4444-5555-666677778888', title: 'Paginating a list endpoint', url: 'https://www.notion.so/Pagination-11112222333344445555666677778888' },
    ])
  })

  it('ignores databases and returns nothing for a leaf page', () => {
    expect(childPagesOf('Just prose.')).toEqual([])
  })

  it('treats self-closing mention-page tags as children with no title, once per id', () => {
    const md = `<mention-page url="https://app.notion.com/p/3e73e59b22588149ad19dc1b7ac97ac4"/>\n<mention-page url="https://app.notion.com/p/3e73e59b22588149ad19dc1b7ac97ac4"/>\n<mention-database url="https://app.notion.com/p/bc25fc5cf5464f2593c7a0b663d6f859">Slop</mention-database>`
    expect(childPagesOf(md)).toEqual([{ id: '3e73e59b-2258-8149-ad19-dc1b7ac97ac4', title: '', url: 'https://app.notion.com/p/3e73e59b22588149ad19dc1b7ac97ac4' }])
  })
})

describe('fileFor', () => {
  it('slugifies the title under the knowledge folder', () => {
    expect(fileFor('Agents start here')).toBe(`${KNOWLEDGE_PATH}/agents-start-here.md`)
    expect(fileFor('Paginating a list endpoint (v2)')).toBe(`${KNOWLEDGE_PATH}/paginating-a-list-endpoint-v2.md`)
  })

  it('keeps distinct titles distinct when slugs collide by taking a suffix', () => {
    const used = new Set<string>([`${KNOWLEDGE_PATH}/auth.md`])
    expect(fileFor('Auth', used)).toBe(`${KNOWLEDGE_PATH}/auth-2.md`)
  })
})

describe('rewriteLinks', () => {
  it('turns fetched child page tags into local markdown links and leaves unfetched ones as plain links', () => {
    const md = `<page url="https://www.notion.so/A-aaaaaaaabbbbccccddddeeeeeeeeeeee">Agents start here</page> and <page url="https://www.notion.so/B-11112222333344445555666677778888">Elsewhere</page>`
    const local = new Map([['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', `${KNOWLEDGE_PATH}/agents-start-here.md`]])
    expect(rewriteLinks(md, local)).toBe(
      `[Agents start here](${KNOWLEDGE_PATH}/agents-start-here.md) and [Elsewhere](https://www.notion.so/B-11112222333344445555666677778888)`,
    )
  })
})

describe('rewriteLinks with mentions', () => {
  it('turns a mention of a fetched page into a titled local link and leaves other mentions as URLs', () => {
    const md = `<mention-page url="https://app.notion.com/p/3e73e59b22588149ad19dc1b7ac97ac4"/> then <mention-page url="https://app.notion.com/p/b62da71dab204ffb8450675c6dfc0bf7"/>`
    const local = new Map([['3e73e59b-2258-8149-ad19-dc1b7ac97ac4', `${KNOWLEDGE_PATH}/react-typescript-rules.md`]])
    const titles = new Map([['3e73e59b-2258-8149-ad19-dc1b7ac97ac4', 'React / TypeScript Rules']])
    expect(rewriteLinks(md, local, titles)).toBe(
      `[React / TypeScript Rules](${KNOWLEDGE_PATH}/react-typescript-rules.md) then [https://app.notion.com/p/b62da71dab204ffb8450675c6dfc0bf7](https://app.notion.com/p/b62da71dab204ffb8450675c6dfc0bf7)`,
    )
  })
})

describe('renderPage', () => {
  it('prefixes the markdown with a provenance header', () => {
    const out = renderPage({ title: 'Auth', url: 'https://www.notion.so/Auth-1', fetchedAt: '2026-09-26T10:00:00.000Z', truncated: false }, '# Auth\n\nBody')
    expect(out).toBe('<!-- Auth · https://www.notion.so/Auth-1 · fetched 2026-09-26T10:00:00.000Z -->\n\n# Auth\n\nBody\n')
  })

  it('flags a truncated page so a reader knows to follow the source link', () => {
    const out = renderPage({ title: 'Big', url: 'u', fetchedAt: 't', truncated: true }, 'Body')
    expect(out).toContain('TRUNCATED')
  })
})

describe('parseRequired', () => {
  it('defaults when the variable is unset and means none when it is empty', () => {
    expect(parseRequired(undefined)).toEqual(DEFAULT_REQUIRED)
    expect(parseRequired('')).toEqual([])
    expect(parseRequired('  ,  ')).toEqual([])
  })

  it('splits on commas and trims', () => {
    expect(parseRequired(' Agent Instructions ,Review Verification')).toEqual(['Agent Instructions', 'Review Verification'])
  })
})

describe('resolveRequired', () => {
  const pages: LoadedPage[] = [
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Agent Instructions', url: 'https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee', markdown: 'read me' },
    { id: '11112222-3333-4444-5555-666677778888', title: 'Review Verification', url: 'https://app.notion.com/p/11112222333344445555666677778888', markdown: '**REV-001 — MUST** check.' },
  ]

  it('matches by title regardless of case, or by URL, in the order required, once each', () => {
    const { found, missing } = resolveRequired(['review verification', 'https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee', 'Review Verification'], pages)
    expect(found.map((p) => p.title)).toEqual(['Review Verification', 'Agent Instructions'])
    expect(missing).toEqual([])
  })

  it('reports what it could not find instead of guessing', () => {
    expect(resolveRequired(['Agent Instructions', 'Security Rules'], pages).missing).toEqual(['Security Rules'])
  })
})

describe('renderRequired', () => {
  it('concatenates the pages under their titles with their sources, after a header that says to read it whole', () => {
    const out = renderRequired(
      [{ id: 'x', title: 'Review Verification', url: 'https://app.notion.com/p/x', markdown: '**REV-001 — MUST** check.\n' }],
      '2026-09-27T00:00:00Z',
    )
    expect(out).toMatch(/^<!-- Required reading · 1 page · fetched 2026-09-27T00:00:00Z -->/)
    expect(out).toContain('in full before its first finding')
    expect(out).toContain('# Review Verification\n\n<!-- https://app.notion.com/p/x -->\n\n**REV-001 — MUST** check.')
    expect(REQUIRED_FILE).toBe(`${KNOWLEDGE_PATH}/REQUIRED.md`)
  })
})
