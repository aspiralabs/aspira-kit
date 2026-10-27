// Copyright 2025 the cartographer authors (https://github.com/kingbootoshi/cartographer)
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
// compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// Modified by Aspira Labs (KIT-69): cartographer's notes as one JSON file per note with a candidate, accepted, stale and
// retired lifecycle, evidence hashes of the cited files, validation of every note file read, and redaction on every write.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import { readEffectiveAspira } from '@aspiralabs/ai/common/lib/aspira-config'
import { envValues, redactSecrets } from '@aspiralabs/ai/common/lib/redact'
import { hashFile } from './scan.ts'

export const NOTE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/
export const STATUSES = ['candidate', 'accepted', 'stale', 'retired'] as const

export const Note = z.object({
  id: z.string().regex(NOTE_ID),
  title: z.string().optional(),
  status: z.enum(STATUSES),
  text: z.string(),
  evidence: z.array(z.object({ path: z.string().min(1), hash: z.string() })),
})
export type Note = z.infer<typeof Note>

export type NotesRead = { notes: Note[]; warnings: string[] }

/** A repo-relative path that stays inside the repo. */
export function insideRepo(path: string): boolean {
  if (isAbsolute(path) || path.includes('\0')) return false
  const clean = normalize(path)
  return clean !== '..' && !clean.startsWith(`..${sep}`) && clean !== '.'
}

export const noteFile = (notesDir: string, id: string): string => join(notesDir, `${id}.json`)

/** The id for a proposed note: a slug of its title and a random suffix, so two branches never pick the same one. */
export function newNoteId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'note'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

/** Every valid note file of the folder; a file whose name, id or cited path is invalid or outside the repo is ignored with a warning. */
export async function readNotes(notesDir: string): Promise<NotesRead> {
  const names = (await readdir(notesDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
  const notes: Note[] = []
  const warnings: string[] = []
  for (const name of names) {
    const fileId = name.slice(0, -5)
    let parsed: ReturnType<typeof Note.safeParse>
    try {
      parsed = Note.safeParse(JSON.parse(await readFile(join(notesDir, name), 'utf8')))
    } catch {
      warnings.push(`ignoring note file ${name}: not valid JSON`)
      continue
    }
    if (!NOTE_ID.test(fileId) || !parsed.success || parsed.data.id !== fileId) {
      warnings.push(`ignoring note file ${name}: invalid name, id or shape`)
      continue
    }
    const outside = parsed.data.evidence.find((entry) => !insideRepo(entry.path))
    if (outside !== undefined) {
      warnings.push(`ignoring note ${fileId}: its cited path ${outside.path} is outside the repo`)
      continue
    }
    notes.push(parsed.data)
  }
  return { notes, warnings }
}

const appOf = async (repo: string): Promise<string | undefined> => {
  try {
    const app = readEffectiveAspira(repo).config.app
    return typeof app === 'string' && insideRepo(app) ? app : undefined
  } catch {
    return undefined
  }
}

/** The folder of the package that holds `path`: the nearest ancestor with a package.json. */
async function packageFolder(repo: string, path: string): Promise<string> {
  let dir = dirname(path)
  while (dir !== '.' && dir !== '/') {
    if (await readFile(join(repo, dir, 'package.json')).then(() => true, () => false)) return dir
    dir = dirname(dir)
  }
  return '.'
}

/** `text` with credentials replaced: the repo root's and app's credential values, those of the cited packages' folders, and token shapes. */
export async function redactNoteText(text: string, repo: string, paths: string[]): Promise<string> {
  const folders = [...new Set(await Promise.all(paths.filter(insideRepo).map((path) => packageFolder(repo, path))))].filter((dir) => dir !== '.')
  const extra = (await Promise.all(folders.map((dir) => envValues(join(repo, dir), {}, true)))).flat()
  const app = await appOf(repo)
  return redactSecrets(text, repo, { ...(app === undefined ? {} : { app }), extra })
}

/** Writes the note redacted, to a temp file renamed over the note, so a reader or a second writer never sees half a file. */
export async function writeNote(notesDir: string, repo: string, note: Note): Promise<void> {
  const paths = note.evidence.map((entry) => entry.path)
  const clean: Note = {
    id: note.id,
    ...(note.title === undefined ? {} : { title: await redactNoteText(note.title, repo, paths) }),
    status: note.status,
    text: await redactNoteText(note.text, repo, paths),
    evidence: note.evidence,
  }
  await mkdir(notesDir, { recursive: true })
  const tmp = join(notesDir, `.${note.id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`)
    await rename(tmp, noteFile(notesDir, note.id))
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export class NoteError extends Error {}

async function find(notesDir: string, id: string): Promise<{ note: Note; warnings: string[] }> {
  if (!NOTE_ID.test(id)) throw new NoteError(`${id} is not a note id`)
  const { notes, warnings } = await readNotes(notesDir)
  const note = notes.find((candidate) => candidate.id === id)
  if (note === undefined) throw new NoteError(`no note ${id}`)
  return { note, warnings }
}

/** candidate or stale to accepted (a stale note's cited hashes are recorded again); accepted stays; retired is refused. */
export async function acceptNote(notesDir: string, repo: string, id: string): Promise<Note> {
  const { note } = await find(notesDir, id)
  if (note.status === 'retired') throw new NoteError(`note ${id} is retired; retirement is final`)
  if (note.status === 'accepted') return note
  let evidence = note.evidence
  if (note.status === 'stale') {
    evidence = await Promise.all(
      note.evidence.map(async (entry) => {
        try {
          return { path: entry.path, hash: await hashFile(join(repo, entry.path)) }
        } catch {
          throw new NoteError(`note ${id} cites ${entry.path}, which is gone; retire it or fix its evidence`)
        }
      }),
    )
  }
  const next: Note = { ...note, status: 'accepted', evidence }
  await writeNote(notesDir, repo, next)
  return next
}

/** Any status to retired; retired stays. */
export async function retireNote(notesDir: string, repo: string, id: string): Promise<Note> {
  const { note } = await find(notesDir, id)
  if (note.status === 'retired') return note
  const next: Note = { ...note, status: 'retired' }
  await writeNote(notesDir, repo, next)
  return next
}

/** Accepted notes whose cited file changed or left the file list become stale; candidate, stale and retired notes are not touched. Returns the ids. */
export async function markStale(notesDir: string, repo: string, files: Record<string, string>): Promise<string[]> {
  const { notes } = await readNotes(notesDir)
  const changed: string[] = []
  for (const note of notes) {
    if (note.status !== 'accepted') continue
    if (note.evidence.every((entry) => files[entry.path] === entry.hash)) continue
    await writeNote(notesDir, repo, { ...note, status: 'stale' })
    changed.push(note.id)
  }
  return changed
}
