// Walks the guidelines tree through the shared walk and prints what load-knowledge would write,
// without writing anything or calling a model. Reads NOTION_TOKEN and KNOWLEDGE_PAGE from the
// environment (a --env-file flag on node points it at an agent's .env.local).
//
//   node --env-file=../spec-reviewer/.env.local scripts/probe-knowledge.ts
//
// Prints one line per page (the file it would become, its title, how long its markdown is) and
// the first lines of INDEX.md, so a page that is not shared with the integration, or a tree that
// is deeper than the walk, shows up before a paid run.

import { KNOWLEDGE_ENV } from '../src/lib/knowledge.ts'
import { walkKnowledge, type WalkResult } from '../src/lib/knowledge-walk.ts'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type ListFilesDeps = { token: string; page: string; required?: string[]; api?: string; fetch?: Fetch }

/** The sorted basenames walkKnowledge would write (INDEX.md plus one file per visited page), without writing anything. */
export async function listFiles(deps: ListFilesDeps): Promise<string[]> {
  const walk = await preview(deps)
  return walk.pages.map((p) => p.file).sort()
}

async function preview(deps: ListFilesDeps): Promise<WalkResult> {
  return walkKnowledge({ token: deps.token, page: deps.page, required: deps.required ?? [], ...(deps.api ? { api: deps.api } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) })
}

async function main(): Promise<void> {
  const token = process.env[KNOWLEDGE_ENV.token]?.trim()
  const start = process.env[KNOWLEDGE_ENV.page]?.trim()
  if (!token || !start) {
    console.error(`Set ${KNOWLEDGE_ENV.token} and ${KNOWLEDGE_ENV.page} (for example: node --env-file=../spec-reviewer/.env.local scripts/probe-knowledge.ts)`)
    process.exitCode = 2
    return
  }
  try {
    const walk = await preview({ token, page: start })
    for (const p of walk.pages) console.log(`${p.file}  ${p.title}  (${p.markdown.length} chars)`)
    if (walk.notLoaded.length > 0) console.log(`\n${walk.notLoaded.length} page(s) not visited (depth or page cap): ${walk.notLoaded.map((p) => p.title).join(', ')}`)
    console.log(`\n${walk.pages.length} page(s). INDEX.md would begin:\n`)
    const index = walk.pages.find((p) => p.file === 'INDEX.md')
    console.log((index?.markdown ?? '').split('\n').slice(0, 30).join('\n'))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href
if (isMain) await main()
