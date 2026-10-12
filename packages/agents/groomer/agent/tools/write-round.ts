import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { groomPageState } from '@aspiralabs/agent-common/lib/decisions'
import { readGroomRecord, validateIdeaSummary } from '@aspiralabs/agent-common/lib/groom-record'
import { requireBound } from '../lib/bound.ts'
import { roundSchema } from '../lib/rounds.ts'

// The model's only way to write (F23): `round-<n>.json`, validated by roundSchema, and
// `idea-summary.md`, only once the pulled page (`<output>/trace/decisions.md`) shows Confirm ticked
// and groom.json has no open question, validated against groom.json. Every other path is refused.
// `<output>` is the ticket's `.work/<id>-<slug>/groom`; groom.json is `<output>/trace/groom.json`.

const ROUND_FILE = /^round-(\d+)\.json$/
export const IDEA_SUMMARY_NAME = 'idea-summary.md'

/** Writes one file under `output` and returns its path; throws, writing nothing, on any other path or state. */
export async function writeRound(output: string, file: { path: string; content: string }): Promise<string> {
  const dir = resolve(output)
  if (file.path !== basename(file.path) || resolve(dir, file.path) !== join(dir, file.path)) throw new Error(`write-round writes only directly under ${dir}; refused ${file.path}`)
  const target = join(dir, file.path)
  const round = ROUND_FILE.exec(file.path)
  if (round !== null) {
    let value: unknown
    try {
      value = JSON.parse(file.content)
    } catch (error) {
      throw new Error(`${file.path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = roundSchema.safeParse(value)
    if (!parsed.success) throw new Error(`${file.path} does not match the round schema: ${parsed.error.message}`)
    if (parsed.data.round !== Number(round[1])) throw new Error(`${file.path} holds round ${parsed.data.round}`)
    await mkdir(dir, { recursive: true })
    await writeFile(target, `${JSON.stringify(parsed.data, null, 2)}\n`)
    return target
  }
  if (file.path === IDEA_SUMMARY_NAME) {
    const record = await readGroomRecord(dirname(dir))
    if (record === undefined) throw new Error(`${join(dir, 'trace', 'groom.json')} is missing; the Idea summary is written only over a recorded run`)
    const page = await readFile(join(dir, 'trace', 'decisions.md'), 'utf8').catch(() => '')
    const open = record.decisions.filter((decision) => decision.decidedBy === 'open').length
    if (open > 0 || !groomPageState(page).confirmTicked) throw new Error(`the Idea summary is written only when Confirm is ticked and no question is open (${open} open)`)
    const valid = validateIdeaSummary(file.content, record)
    if (!valid.ok) throw new Error(`idea summary does not match groom.json: ${valid.reason}`)
    await writeFile(target, file.content.endsWith('\n') ? file.content : `${file.content}\n`)
    return target
  }
  throw new Error(`write-round writes only round-<n>.json and ${IDEA_SUMMARY_NAME}; refused ${file.path}`)
}

export default defineTool({
  availableInSubagents: false,
  description:
    'Write the groomer round or the Idea summary into the ticket\'s groom output folder (.work/<id>-<slug>/groom). kind "round" writes round-<n>.json after validating it against the round schema; kind "summary" writes idea-summary.md, only when the pulled Grooming Decisions page shows Confirm ticked and no question is open, and only when it matches groom.json. Every other path is refused. Never writes the card, the page or the repository.',
  inputSchema: z.object({
    output: z.string().min(1).describe('Absolute path of the ticket\'s groom output folder, .work/<id>-<slug>/groom.'),
    write: z.discriminatedUnion('kind', [z.object({ kind: z.literal('round'), round: roundSchema }), z.object({ kind: z.literal('summary'), markdown: z.string().min(1) })]),
  }),
  async execute({ output, write }) {
    requireBound('output', output)
    const path = write.kind === 'round' ? `round-${write.round.round}.json` : IDEA_SUMMARY_NAME
    const content = write.kind === 'round' ? JSON.stringify(write.round) : write.markdown
    return { written: await writeRound(output, { path, content }) }
  },
})
