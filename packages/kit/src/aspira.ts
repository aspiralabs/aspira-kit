// aspira.json at the project root: the project's Feature Board (a Notion URL) and, when given, its
// Releases page. `kit init --board` writes it, `kit doctor` checks it, the skills and `kit next` read it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson, type Log } from './fs.js'

export const ASPIRA_FILE = 'aspira.json'

export type AspiraConfig = { board: string; releases?: string }

/** A Notion page or database URL (notion.so or app.notion.com) or a collection:// data source URL. */
export function isNotionUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https:\/\/(www\.|app\.)?notion\.(so|com)\/\S+|collection:\/\/[0-9a-f-]{32,36})$/i.test(value.trim())
}

export function readAspira(projectRoot: string): Partial<AspiraConfig> | undefined {
  return readJson<Partial<AspiraConfig>>(join(projectRoot, ASPIRA_FILE))
}

/** Write or update aspira.json. A key that is not given keeps its current value. */
export function writeAspira(opts: { projectRoot: string; board?: string; releases?: string; dryRun: boolean; log: Log }): void {
  const path = join(opts.projectRoot, ASPIRA_FILE)
  const current = readAspira(opts.projectRoot) ?? {}
  const next: Partial<AspiraConfig> = { ...current }
  if (opts.board !== undefined) {
    if (!isNotionUrl(opts.board)) throw new Error(`--board must be the Feature Board's Notion URL, got: ${opts.board}`)
    next.board = opts.board.trim()
  }
  if (opts.releases !== undefined) {
    if (!isNotionUrl(opts.releases)) throw new Error(`--releases must be the Releases page's Notion URL, got: ${opts.releases}`)
    next.releases = opts.releases.trim()
  }
  if (next.board === undefined) {
    opts.log(`skip   ${path} (no --board given; the project has no Feature Board until it is)`)
    return
  }
  if (existsSync(path) && JSON.stringify(current) === JSON.stringify(next)) {
    opts.log(`keep   ${path} (board already set)`)
    return
  }
  opts.log(`${existsSync(path) ? 'update' : 'write '} ${path} (board${next.releases === undefined ? '' : ', releases'})`)
  if (!opts.dryRun) writeJson(path, next)
}

/** The doctor's view: ok, or why not. */
export function checkAspira(projectRoot: string): { ok: boolean; reason?: string } {
  const path = join(projectRoot, ASPIRA_FILE)
  if (!existsSync(path)) return { ok: false, reason: `${ASPIRA_FILE} is missing; run kit init --board <Feature Board URL>` }
  let config: Partial<AspiraConfig> | undefined
  try {
    config = readAspira(projectRoot)
  } catch {
    return { ok: false, reason: `${ASPIRA_FILE} is not valid JSON` }
  }
  if (!isNotionUrl(config?.board)) return { ok: false, reason: `${ASPIRA_FILE} has no "board" Notion URL; run kit init --board <Feature Board URL>` }
  if (config?.releases !== undefined && !isNotionUrl(config.releases)) return { ok: false, reason: `${ASPIRA_FILE} "releases" is not a Notion URL` }
  return { ok: true }
}
