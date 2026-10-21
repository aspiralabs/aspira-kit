// The run packet file (KIT-48): `.work/<id>-<slug>/packet.md`, rewritten before every step from
// what exists then, and handed to the steps that take `--packet` (the spec writer and the planner).

import { execFile } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { renderPacket } from '@aspiralabs/agent-common/lib/packet'
import type { StepName } from '#src/route.ts'

const exec = promisify(execFile)

/** The ticket files the packet lists when they exist, by name. */
const TICKET_FILES: { name: string; file: string }[] = [
  { name: 'ticket', file: 'ticket.md' },
  { name: 'idea', file: 'idea.md' },
  { name: 'grooming decisions', file: 'groom/trace/decisions.md' },
  { name: 'spec', file: 'spec.md' },
  { name: 'reviewed spec', file: 'spec.reviewed/spec.reviewed.md' },
  { name: 'spec decisions', file: 'spec.reviewed/trace/decisions.md' },
  { name: 'plan', file: 'plan.review/plan.reviewed.md' },
  { name: 'implementation', file: 'plan.review/implementation.md' },
]

/** The steps whose launcher takes `--packet`. */
export const PACKET_STEPS: readonly StepName[] = ['spec-writer', 'planner']

/** Writes the packet for the next step and returns its path, or null when the repository cannot be listed. */
export async function writeRunPacket(input: { repo: string; folder: string; aspira: { app?: string; repository?: string; gates?: { cwd?: string; command: string }[] } | null; knowledgeDir?: string | null }): Promise<string | null> {
  const listing = await exec('git', ['-C', input.repo, 'ls-files', '-z', '-co', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 }).catch(() => null)
  if (listing === null) return null
  const files = [...new Set(listing.stdout.split('\0').filter((path) => path !== '' && !path.startsWith('.work/')))]
  const ticketFiles: { name: string; path: string; bytes: number }[] = []
  for (const entry of TICKET_FILES) {
    const path = join(input.folder, entry.file)
    const info = await stat(path).catch(() => null)
    if (info?.isFile()) ticketFiles.push({ name: entry.name, path, bytes: info.size })
  }
  const file = join(input.folder, 'packet.md')
  await writeFile(file, renderPacket({ files, aspira: input.aspira, ticketFiles, knowledgeDir: input.knowledgeDir ?? null }))
  return file
}
