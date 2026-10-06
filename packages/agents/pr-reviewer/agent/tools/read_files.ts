/* eslint-disable unicorn/filename-case -- eve names a tool after its file, and this one is read_files: the spec's name, beside the built-in read_file */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { callsSoFar, capRefusal, maxSeatCalls } from '../lib/call-cap'
import { MAX_FULL_FILE_CHARS, truncateForRead } from '../lib/packet'
import { REPO_PATH } from '../lib/review'

// Many files in one call, for the seats and Quinn: one read of everything a seat wants before it
// writes, instead of a model call per file. Each file is numbered and cut past the same cap as
// the packet, with a pointer. Past the per-round call cap it refuses and tells the seat to write.

const MAX_PATHS = 40

export default defineTool({
  description: `Read up to ${MAX_PATHS} files from the sandbox in one call. Paths are absolute, or relative to the checked-out tree at ${REPO_PATH}. Each file comes back line-numbered; one over ${MAX_FULL_FILE_CHARS.toLocaleString('en-US')} characters is cut with a pointer. Decide everything you want to read, then make one call. Counts as one tool call toward the per-round cap; at the cap it refuses and you write with what you have.`,
  inputSchema: z.object({
    paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe('The files to read, all of them in one call.'),
  }),
  async execute({ paths }, ctx) {
    const cap = maxSeatCalls()
    const made = callsSoFar(ctx.session.id)
    const refusal = capRefusal(made, cap, paths)
    if (refusal !== null) return refusal
    const sandbox = await ctx.getSandbox()
    const files: { path: string; lines?: number; truncated?: boolean; content?: string; error?: string }[] = []
    for (const path of paths) {
      const absolute = path.startsWith('/') ? path : `${REPO_PATH}/${path}`
      const content = await Promise.resolve(sandbox.readTextFile({ path: absolute })).catch(() => null)
      if (content === null) {
        files.push({ path, error: `not found: ${absolute}. Find the real path with search before citing it.` })
        continue
      }
      const read = truncateForRead(content)
      files.push({ path, lines: read.lines, truncated: read.truncated, content: read.text })
    }
    return { files, calls: { made: made + 1, cap } }
  },
})
