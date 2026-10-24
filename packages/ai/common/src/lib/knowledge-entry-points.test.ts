// T56 (F48): knowledge-walk.ts (walkKnowledge) does not exist yet (P26), and probe-knowledge.ts
// does not yet export a `listFiles` function — both land together with it. This file is the
// cross-entry-point contract the feature exists to enforce: the load-knowledge command, the eve
// load-knowledge tool and the probe-knowledge script must all derive their written file names from
// the one shared walk, so the three separate copies this feature removes (the eve tool's own BFS,
// code-analyzer's host copy and probe-knowledge's own BFS) can never again drift apart.
//
// probe-knowledge.ts gains `listFiles(deps): Promise<string[]>`: the sorted basenames
// walkKnowledge would write (INDEX.md plus one file per visited page), without writing anything —
// the same preview the script prints today, as a plain async function instead of a top-level
// side effect reading `process.env` at import time.
//
// All three entry points run here against the same mock Notion tree and must agree on the written
// (or, for the probe, would-be-written) file name for every page.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadKnowledgeCommand } from './knowledge-walk'
import { NOTION_API } from './knowledge'
import loadKnowledgeTool from '../tools/load-knowledge'
import { listFiles } from '../../scripts/probe-knowledge'

const TOKEN = 'test-token'

/** A 32-hex Notion page id, dashed the way pageIdFrom expects, distinct per `n`. */
function fakeId(n: number): string {
  const hex = `aabb${n.toString(16).padStart(28, '0')}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const urlFor = (id: string, title: string) => `https://www.notion.so/${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${id.replace(/-/g, '')}`

type PageDef = { title: string; markdown: string }

/** A minimal Notion server: GET /v1/pages/{id} (title only) and GET /v1/pages/{id}/markdown, from `pages`. */
async function notionServer(pages: Map<string, PageDef>): Promise<{ api: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const json = (code: number, body: unknown) => {
      response.writeHead(code, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const match = request.url?.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
    const id = match?.[1]
    const def = id === undefined ? undefined : pages.get(id)
    if (def === undefined) return json(404, { object: 'error', status: 404, message: `no page ${id}` })
    if (match?.[2] === '/markdown') return json(200, { markdown: def.markdown, truncated: false })
    return json(200, { properties: { title: { id: 'title', type: 'title', title: [{ plain_text: def.title }] } } })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { api, close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))) }
}

const ROOT = fakeId(0)
const AGENT_INSTRUCTIONS = fakeId(1)
const REVIEW_VERIFICATION = fakeId(2)
const TOPIC_A = fakeId(3)
const REQUIRED = ['Agent Instructions', 'Review Verification']

function tag(id: string, title: string): string {
  return `<page url="${urlFor(id, title)}">${title}</page>`
}

function basicTree(): Map<string, PageDef> {
  const pages = new Map<string, PageDef>()
  pages.set(ROOT, { title: 'Engineering', markdown: `# Engineering\n\n${tag(AGENT_INSTRUCTIONS, 'Agent Instructions')}\n${tag(REVIEW_VERIFICATION, 'Review Verification')}\n${tag(TOPIC_A, 'Topic A')}\n` })
  pages.set(AGENT_INSTRUCTIONS, { title: 'Agent Instructions', markdown: '**TS-004 — MUST** validate external data.' })
  pages.set(REVIEW_VERIFICATION, { title: 'Review Verification', markdown: '**REV-001 — MUST** read AGENTS.md.' })
  pages.set(TOPIC_A, { title: 'Topic A', markdown: 'Some notes on Topic A.' })
  return pages
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

type ExecutableTool = { execute: (input: unknown, ctx: unknown) => Promise<unknown> }

describe('the command, the eve tool and the probe agree on file names for the same tree', () => {
  it('produce the same set of written (or would-be-written) file names', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const rootUrl = urlFor(ROOT, 'Engineering')

    // The load-knowledge command.
    const repo = await tempDir('kep-cmd-')
    const out = join(repo, 'knowledge')
    const commandResult = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: rootUrl, required: REQUIRED })
    expect(commandResult.code).toBe(0)
    const commandFiles = (await readdir(out)).filter((file) => file !== 'REQUIRED.md').sort()

    // The eve load-knowledge tool, through a fake sandbox. The tool's Notion host is hardcoded
    // (NOTION_API), so the one network boundary it calls through is redirected to this same mock
    // server by address, exactly as it would reach the real host — nothing about request/response
    // handling is faked.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return realFetch(href.startsWith(NOTION_API) ? api + href.slice(NOTION_API.length) : href, init)
    })
    vi.stubEnv('NOTION_TOKEN', TOKEN)
    vi.stubEnv('KNOWLEDGE_PAGE', rootUrl)
    vi.stubEnv('KNOWLEDGE_REQUIRED', REQUIRED.join(','))
    const writes: string[] = []
    const fakeSandbox = {
      run: async () => ({}),
      writeTextFile: async ({ path }: { path: string; content: string }) => {
        writes.push(path)
      },
    }
    const tool = loadKnowledgeTool as unknown as ExecutableTool
    await tool.execute({}, { getSandbox: async () => fakeSandbox })
    const toolFiles = writes.map((path) => basename(path)).filter((file) => file !== 'REQUIRED.md').sort()

    // probe-knowledge's own listing, against the same tree.
    const probeFiles = (await listFiles({ token: TOKEN, api, page: rootUrl })).slice().sort()

    expect(toolFiles).toEqual(commandFiles)
    expect(probeFiles).toEqual(commandFiles)
  })
})
