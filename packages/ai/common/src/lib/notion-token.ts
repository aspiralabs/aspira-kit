// Where NOTION_TOKEN comes from for a project's own tooling (the load-knowledge command, kit
// next's board resolver): the process env, then the app's .env.local, then the project root's —
// the same root-then-app precedence kit next resolves other project env files in
// (packages/kit/src/next.ts), with the app's value winning over the root's. It never reads an
// agent package's own .env.local: that file is for the agent's own runtime config
// (packages/ai/code-analyzer/agent/lib/knowledge.ts's agentEnv reads it for that), not a place
// a project is expected to put its Notion token.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { clientRootOf } from './aspira-config.ts'

export type NotionTokenSource = 'env' | 'app' | 'root'
export type NotionTokenResult = { token: string; source: NotionTokenSource }

async function tokenIn(file: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return undefined
  const value = parseEnv(text).NOTION_TOKEN
  return value === undefined || value.trim() === '' ? undefined : value
}

/**
 * The roots to look the token in for a run in `from` (KIT-68): inside a client layout the client root and no app
 * (the repo's own .env.local is never read for the kit); elsewhere `projectRoot` and `appDir` as given.
 */
export function tokenRoots(from: string, projectRoot: string, appDir?: string): { projectRoot: string; appDir?: string } {
  const client = clientRootOf(from)
  if (client !== undefined) return { projectRoot: client }
  return appDir === undefined ? { projectRoot } : { projectRoot, appDir }
}

export async function notionToken(input: { env: NodeJS.ProcessEnv | Record<string, string | undefined>; projectRoot: string; appDir?: string }): Promise<NotionTokenResult | null> {
  const fromEnv = input.env.NOTION_TOKEN
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { token: fromEnv, source: 'env' }

  if (input.appDir !== undefined) {
    const fromApp = await tokenIn(join(input.appDir, '.env.local'))
    if (fromApp !== undefined) return { token: fromApp, source: 'app' }
  }

  const fromRoot = await tokenIn(join(input.projectRoot, '.env.local'))
  if (fromRoot !== undefined) return { token: fromRoot, source: 'root' }

  return null
}
