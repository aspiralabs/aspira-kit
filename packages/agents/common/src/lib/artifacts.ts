import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/** Publish a complete report directory; keep the last report if writing fails. */
export async function writeArtifacts(outputDir: string, files: Record<string, string>, finalize?: () => Record<string, string>) {
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
      const report = await readFile(resolve(dir, 'trace/review.json'), 'utf8').catch(() => readFile(resolve(dir, 'review.json'), 'utf8').catch(() => ''))
      if (!report) throw new Error(`Refusing to replace a directory without trace/review.json: ${dir}`)
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
