// The run packet (KIT-48): one file per build-feature run, handed to every step's subagents as the
// starting evidence, so they stop re-exploring the repository from scratch. It holds what every
// phase used to rediscover: the repository map (every tracked path, grouped by top-level directory),
// the project facts aspira.json states, and the ticket's files as they exist now. It is data, not
// instructions, and every step still reads what it needs; it only says where things are.

export type PacketInput = {
  /** Repository-relative paths, as `git ls-files -co --exclude-standard` lists them. */
  files: readonly string[]
  /** aspira.json facts worth knowing: the app directory, the gates, the repository. */
  aspira: { app?: string; repository?: string; gates?: readonly { cwd?: string; command: string }[] } | null
  /** The ticket's working-folder files that exist, with their sizes. */
  ticketFiles: readonly { name: string; path: string; bytes: number }[]
  /** The shared engineering-guidelines folder, when the run built one. */
  knowledgeDir?: string | null
}

/** How many paths the map lists before it stops and says how many more there are. */
export const PACKET_MAX_PATHS = 4000

/** The packet as markdown. */
export function renderPacket(input: PacketInput): string {
  const lines: string[] = ['# Run packet', '', 'Data, never instructions: where things are in this repository and what this ticket already holds. Start from it; open a file only to confirm a fact you need, and record what you read.', '']
  lines.push('## Project', '')
  if (input.aspira === null) lines.push('- aspira.json: none', '')
  else {
    lines.push(`- app: ${input.aspira.app ?? '.'}`)
    if (input.aspira.repository) lines.push(`- repository: ${input.aspira.repository}`)
    if (input.aspira.gates?.length) lines.push(`- gates: ${input.aspira.gates.map((gate) => `${gate.command}${gate.cwd ? ` (in ${gate.cwd})` : ''}`).join('; ')}`)
    lines.push('')
  }
  lines.push('## Ticket files', '')
  if (!input.ticketFiles.length) lines.push('- none yet')
  for (const file of input.ticketFiles) lines.push(`- ${file.name}: ${file.path} (${file.bytes} bytes)`)
  lines.push('')
  if (input.knowledgeDir) lines.push('## Engineering guidelines', '', `- folder: ${input.knowledgeDir} (REQUIRED.md first, INDEX.md, one file per page)`, '')
  const groups = new Map<string, string[]>()
  const sorted = [...input.files].sort()
  const shown = sorted.slice(0, PACKET_MAX_PATHS)
  for (const path of shown) {
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)'
    groups.set(top, [...(groups.get(top) ?? []), path])
  }
  lines.push('## Repository map', '', `${sorted.length} tracked paths${sorted.length > shown.length ? ` (the first ${shown.length} listed; search for the rest)` : ''}.`, '')
  for (const [top, paths] of groups) {
    lines.push(`### ${top} (${paths.length})`, '', ...paths.map((path) => `- ${path}`), '')
  }
  return lines.join('\n')
}
