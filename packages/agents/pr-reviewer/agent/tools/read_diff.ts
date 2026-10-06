/* eslint-disable unicorn/filename-case -- eve names a tool after its file; read_diff sits beside read_files and the built-in read_file */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { callsSoFar, capRefusal, maxSeatCalls } from '../lib/call-cap'
import { MAX_FULL_FILE_CHARS, hunksFor } from '../lib/packet'
import { FILES } from '../lib/review'

// The hunks of the changed files a seat picked from the index, in one call. The packet carries
// no hunks on purpose: a seat fetches only the files its lens needs, and what it fetches lives in
// its own context. Each file is cut past the same cap as read_files, with a pointer. Counts
// against the per-round call cap; past it, it refuses and the seat writes with what it has.

const MAX_PATHS = 40

export default defineTool({
  description: `Fetch the diff hunks of up to ${MAX_PATHS} changed files in one call, by the paths the packet's index lists. Each file's hunks come back as they are in the patch; a file over ${MAX_FULL_FILE_CHARS.toLocaleString('en-US')} characters of hunks is cut with a pointer. Choose by your lens from the index, then make one call for everything you will review; do not fetch what you will not review. Counts as one tool call toward the per-round cap.`,
  inputSchema: z.object({
    paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe('Changed paths from the index, all of them in one call.'),
  }),
  async execute({ paths }, ctx) {
    const cap = maxSeatCalls()
    const made = callsSoFar(ctx.session.id)
    const refusal = capRefusal(made, cap, paths)
    if (refusal !== null) return refusal
    const sandbox = await ctx.getSandbox()
    const patch = (await Promise.resolve(sandbox.readTextFile({ path: FILES.patch })).catch(() => null)) ?? ''
    return { files: hunksFor(patch, paths), calls: { made: made + 1, cap } }
  },
})
