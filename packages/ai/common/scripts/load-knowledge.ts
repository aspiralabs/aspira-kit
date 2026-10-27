// load-knowledge --out DIR [--page URL] [--required a,b,c]: refreshes a knowledge folder from
// Notion through the shared walk (knowledge-walk.ts), the same one the eve load-knowledge tool,
// probe-knowledge and code-analyzer's host copy use. The token comes from notion-token.ts (the
// process env, then the project's app .env.local, then its root .env.local); the page from --page
// or KNOWLEDGE_PAGE. Exits non-zero naming the page on any failure.
//
//   node --env-file=.env.local scripts/load-knowledge.ts --out .work/kit-2-x/knowledge
//
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { KNOWLEDGE_ENV, REQUIRED_ENV, parseRequired } from '../src/lib/knowledge.ts'
import { loadKnowledgeCommand } from '../src/lib/knowledge-walk.ts'
import { notionToken, tokenRoots } from '../src/lib/notion-token.ts'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, page: { type: 'string' }, required: { type: 'string' } }, strict: false, allowPositionals: true })

  const out = typeof values.out === 'string' ? values.out : undefined
  if (out === undefined || out === '') {
    console.error('Usage: load-knowledge --out DIR [--page URL] [--required a,b]')
    return 1
  }

  const resolvedToken = await notionToken({ env: process.env, ...tokenRoots(process.cwd(), process.cwd()) })
  if (resolvedToken === null) {
    console.error(`No ${KNOWLEDGE_ENV.token} found: set it in the environment, the project's .env.local, or pass --env-file.`)
    return 1
  }

  const page = (typeof values.page === 'string' ? values.page : undefined) ?? process.env[KNOWLEDGE_ENV.page]?.trim()
  if (page === undefined || page === '') {
    console.error(`No page to start from: pass --page URL or set ${KNOWLEDGE_ENV.page}.`)
    return 1
  }

  const required = typeof values.required === 'string' ? parseRequired(values.required) : parseRequired(process.env[REQUIRED_ENV])

  const result = await loadKnowledgeCommand(['--out', resolve(out)], { token: resolvedToken.token, page, required })
  console[result.code === 0 ? 'log' : 'error'](result.message)
  return result.code
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href
if (isMain) process.exitCode = await main()
