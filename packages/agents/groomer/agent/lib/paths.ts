import { join } from 'node:path'
import { localStateDir } from '@aspiralabs/agent-common/lib/ticket-flow'

/** The child page the groomer keeps on the card. */
export const GROOM_PAGE = 'Grooming Decisions'

/**
 * Where the groomer's files live in the ticket's working folder `.work/<id>-<slug>/`: `<output>` is
 * `groom/` (the run record, the rounds, the trace), `<output>.local/` the --local work directory.
 */
export function groomPaths(folder: string) {
  const output = join(folder, 'groom')
  const work = `${output}.local`
  return {
    output,
    work,
    knowledge: join(work, 'knowledge'),
    prompts: join(work, 'prompts'),
    round: (n: number) => join(output, `round-${n}.json`),
    answers: (n: number) => join(work, `answers-${n}.json`),
    page: (n: number) => join(work, `page-${n}.md`),
    base: (n: number) => join(work, `base-${n}.json`),
    summary: join(output, 'idea-summary.md'),
    decisions: join(output, 'trace', 'decisions.md'),
    record: join(output, 'trace', 'groom.json'),
    state: join(localStateDir(folder, 'groomer'), 'board.json'),
    idea: join(folder, 'idea.md'),
  }
}
export type GroomPaths = ReturnType<typeof groomPaths>
