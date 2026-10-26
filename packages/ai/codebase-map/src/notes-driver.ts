// The `kit map-codebase notes` step driver. A run with nothing pending prints the next step as one JSON object
// ({ stage, task, output }) for a subagent of the session to do; the next run reads what the subagent wrote to
// `output` and stores each proposal as a candidate note. A candidate shows in no brief until a person accepts it.
// No model or network call is made here: the session's own subagent writes the proposals.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { GRAPH_FILE, readGraph } from './sqlite-store.ts'
import { mapDirs } from './map-root.ts'
import { hashFile } from './scan.ts'
import { insideRepo, newNoteId, readNotes, writeNote, type Note } from './notes.ts'

const Proposals = z.object({ notes: z.array(z.object({ title: z.string().min(1), text: z.string().min(1), paths: z.array(z.string()).min(1) })) })

export type NotesStep = { stage: 'step'; task: string; output: string }

export const proposedFile = (mapRoot: string): string => join(mapRoot, 'notes-step', 'proposed.json')

async function areas(repo: string, mapRoot: string): Promise<string[]> {
  const { mapDir } = await mapDirs(repo, mapRoot)
  const graph = readGraph(join(mapDir, GRAPH_FILE))
  return graph === undefined ? [] : graph.packages.map((pkg) => `${pkg.name} (${pkg.dir})`)
}

/** Prints the next step, or ingests the proposals the last step wrote. Returns the process exit code. */
export async function notesStep(repo: string, mapRoot: string): Promise<number> {
  const output = proposedFile(mapRoot)
  const raw = await readFile(output, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    const list = await areas(repo, mapRoot)
    const step: NotesStep = {
      stage: 'step',
      output,
      task: [
        'Study the code areas below and propose notes a later reader of this repo would want: how a part works, a constraint, a gotcha, a convention.',
        'Each note cites the repo files it rests on. Verify every claim in the source before you write it; never copy a secret or credential value.',
        `Write one JSON file to ${output} shaped { "notes": [{ "title": string, "text": string, "paths": [repo-relative file paths] }] }.`,
        'Run this command again afterwards to store them as candidates. A candidate is not used by any brief: a person turns it on with "notes accept <note-id>", and you must not run accept yourself.',
        list.length === 0 ? 'Areas: the whole repo (no map yet; run kit map-codebase first for a list).' : `Areas: ${list.join(', ')}`,
      ].join('\n'),
    }
    console.log(JSON.stringify(step))
    return 0
  }
  let proposals: z.infer<typeof Proposals>
  try {
    proposals = Proposals.parse(JSON.parse(raw))
  } catch (error) {
    console.error(`map-codebase: ${output} is not the expected { "notes": [...] } JSON (${error instanceof Error ? error.message.split('\n')[0] : 'unreadable'}); fix it and run notes again`)
    return 1
  }
  const { notesDir } = await mapDirs(repo, mapRoot)
  const stored: string[] = []
  for (const proposal of proposals.notes) {
    const bad = proposal.paths.find((path) => !insideRepo(path))
    if (bad !== undefined) {
      console.error(`map-codebase: skipped "${proposal.title}": ${bad} is not a path inside the repo`)
      continue
    }
    try {
      const evidence = await Promise.all(proposal.paths.map(async (path) => ({ path, hash: await hashFile(join(repo, path)) })))
      const note: Note = { id: newNoteId(proposal.title), title: proposal.title, status: 'candidate', text: proposal.text, evidence }
      await writeNote(notesDir, repo, note)
      stored.push(note.id)
    } catch {
      console.error(`map-codebase: skipped "${proposal.title}": a cited file cannot be read`)
    }
  }
  await rm(dirname(output), { recursive: true, force: true })
  await mkdir(notesDir, { recursive: true })
  console.log(`stored ${stored.length} candidate note${stored.length === 1 ? '' : 's'}${stored.length === 0 ? '' : `: ${stored.join(', ')}`}`)
  // each note as it was written (redacted), so the person reads what they would accept
  const written = (await readNotes(notesDir)).notes.filter((note) => stored.includes(note.id))
  for (const note of written) console.log(`\n[${note.id}] ${note.title ?? ''}\n${note.text}`)
  if (written.length > 0) console.log('')
  console.log('a person accepts one with: kit map-codebase notes accept <note-id>')
  return 0
}
