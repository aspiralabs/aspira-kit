import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { SKILLS } from '../lib/ticket'
import { FlowRefused, finishFlow, readAspira, startFlow } from '../lib/ticket-flow'
import { resolveArgument } from '../lib/ticket-driver'
import { board as makeBoard } from '../lib/board'

// The Feature Board for an agent that runs as a separate process: the same flow the skill
// launchers run on the host (start: resolve, gate, pull, claim; finish: push, move), through
// board.ts with NOTION_TOKEN. The launchers already do this around a run, so an agent only calls
// it when its request says the ticket has not been claimed. Runs in the app runtime (network,
// env, host file system); the repository path is a host path.

export default defineTool({
  availableInSubagents: false,
  description:
    'The project Feature Board, through the shared board module. "resolve" reads a ticket (ID or URL) and its Status. "start" gates the skill on the ticket Status, pulls the ticket pages into <repo>/.work/<id>-<slug>/ and claims the ticket (Dev set, In Progress move). "finish" pushes the skill outputs as child pages and makes the success move. Needs NOTION_TOKEN and <repo>/aspira.json. Refuses, with the Status the skill needs and who moves it, when the gate is not met.',
  inputSchema: z.object({
    action: z.enum(['resolve', 'start', 'finish']),
    skill: z.enum(SKILLS),
    repo: z.string().describe('The repository root on the host (holds aspira.json and .work/).'),
    ticket: z.string().optional().describe('A board ID such as NOM-4 or a Notion page URL. Omitted: the one working folder under .work/.'),
    folder: z.string().optional().describe('finish: the working folder the start step returned.'),
    ok: z.boolean().optional().describe('finish: did the run succeed.'),
    runStatus: z.string().optional().describe('finish: the run status word (ready, needs-author, incomplete, complete, clean).'),
    prUrl: z.string().optional().describe('finish, implementor only: the pull request it opened.'),
    exportDir: z.string().optional().describe('finish: the export directory the trace is written into.'),
    forcePull: z.boolean().optional(),
  }),
  async execute(input) {
    const config = await readAspira(input.repo)
    if (config === null) return { refused: true as const, reason: `${input.repo} has no aspira.json; the project has no Feature Board` }
    const client = makeBoard({ board: config.board })
    try {
      if (input.action === 'resolve') {
        const argument = await resolveArgument({ skill: input.skill, repo: input.repo }, { positional: input.ticket })
        if (argument.kind === 'path') return { refused: true as const, reason: 'a ticket is needed' }
        const ticket = await client.resolveTicket(argument.ref)
        return { id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, pr: ticket.pr ?? null, dev: ticket.dev ?? null, pages: Object.keys(ticket.pages) }
      }
      if (input.action === 'start') {
        const argument = await resolveArgument({ skill: input.skill, repo: input.repo }, { positional: input.ticket })
        if (argument.kind === 'path') return { refused: true as const, reason: 'a ticket is needed' }
        const started = await startFlow({ skill: input.skill, repo: input.repo, argument, board: config.board, force: input.forcePull, client })
        return { folder: started.folder, ticket: { id: started.ticket.id, title: started.ticket.title, url: started.ticket.url }, statusBefore: started.trace.statusBefore, status: started.ticket.status, pulled: started.pulled, kept: started.kept, actions: started.trace.actions }
      }
      if (input.folder === undefined || input.ok === undefined || input.runStatus === undefined) return { refused: true as const, reason: 'finish needs folder, ok and runStatus' }
      const finished = await finishFlow({ skill: input.skill, folder: input.folder, ok: input.ok, runStatus: input.runStatus, prUrl: input.prUrl, exportDir: input.exportDir, board: config.board, client })
      return { report: finished.header, pushed: finished.trace.pushed, pushFailures: finished.pushFailures, remaining: finished.remaining, trace: finished.traceFile, actions: finished.trace.actions }
    } catch (error) {
      if (error instanceof FlowRefused) return { refused: true as const, reason: error.message }
      throw error
    }
  },
})
