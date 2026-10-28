import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

/** What proves a directory is one this helper wrote: the report file it holds (default `trace/review.json`; the groomer passes `trace/groom.json`). */
export type ArtifactOptions = { marker?: string }

/**
 * Files a --local session writes into the export directory before the call that exports (the session
 * usage report, KIT-19 F9): carried into the new report so the driver reads it after the export, never
 * left only in trace/history, and never a reason to refuse the directory (KIT-85).
 */
export const CARRIED_FILES = ['trace/session-usage.json']

/** True when every file under `dir` is a carried file: the session's own, not a person's. */
async function onlyCarried(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.every((entry) => entry.isDirectory() || CARRIED_FILES.includes(relative(dir, join(entry.parentPath, entry.name))))
}

/** Publish a complete report directory; keep the last report if writing fails. */
export async function writeArtifacts(outputDir: string, files: Record<string, string>, finalize?: () => Record<string, string>, options: ArtifactOptions = {}) {
  const marker = options.marker ?? 'trace/review.json'
  const dir = resolve(outputDir)
  await mkdir(dirname(dir), { recursive: true })
  const lock = `${dir}.lock`
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`Another review is publishing to ${dir}`)
    throw error
  })
  let staging: string | undefined
  let previous: string | undefined
  try {
    const existing = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Output is not a review directory: ${dir}`)
      const report = await readFile(resolve(dir, marker), 'utf8').catch(() => readFile(resolve(dir, basename(marker)), 'utf8').catch(() => ''))
      if (!report && !(await onlyCarried(dir))) throw new Error(`Refusing to replace a directory without ${marker}: ${dir}`)
    }
    staging = await mkdtemp(resolve(dirname(dir), `.${basename(dir)}-`))
    async function write(batch: Record<string, string>) {
      await Promise.all(Object.entries(batch).map(async ([name, content]) => {
        const target = resolve(staging!, name)
        if (!target.startsWith(`${staging}/`)) throw new Error(`Invalid artifact path: ${name}`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      }))
    }
    // A carried file first, so the run's own files win when they name it too.
    for (const name of CARRIED_FILES) {
      const carried = existing ? await readFile(resolve(dir, name), 'utf8').catch(() => null) : null
      if (carried !== null) await write({ [name]: carried })
    }
    await write(files)
    if (finalize) await write(finalize())
    if (existing) {
      const history = resolve(staging, 'trace/history')
      await mkdir(history, { recursive: true })
      previous = await mkdtemp(`${history}/run-`)
      await rename(dir, previous)
    }
    try { await rename(staging, dir) }
    catch (error) {
      if (previous) await rename(previous, dir)
      throw error
    }
    staging = undefined
    return dir
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}
