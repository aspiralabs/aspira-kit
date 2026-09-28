// Host-side handoff files: large text that one tool produces and another needs.
// Passing it through a model's tool-call arguments costs output tokens at model
// speed (the orchestrator spent ~50s retyping the rules; Darren ~90s retyping the
// checks table), so tools and workflow steps write it here and pass the path.
// Host only: tools and 'use step' functions run on the host; the sandbox never sees it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const HANDOFF_DIR = join(tmpdir(), 'aspira-agents', 'handoff')

/** A unique, readable file name: `<stem>-<time>-<random>.<ext>`. */
export function handoffName(stem: string, ext = 'md'): string {
  const safe = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file'
  return `${safe}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
}

export async function writeHandoff(stem: string, content: string, ext = 'md'): Promise<string> {
  await mkdir(HANDOFF_DIR, { recursive: true })
  const path = join(HANDOFF_DIR, handoffName(stem, ext))
  await writeFile(path, content, 'utf8')
  return path
}

export async function readHandoff(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
