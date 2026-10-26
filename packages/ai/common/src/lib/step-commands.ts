// The one place that turns a ticket id, a branch, a set of changed paths and a PR body file into
// the literal shell commands a progress note's Next action shows (F23). Every value that reaches a
// shell here is untrusted (a card title is free text a human typed on the board; a path comes from
// the code-analyzer's own rounds.json), so every argument that is not a fixed literal is single-quote
// escaped (shellQuote) and never interpolated unquoted.

/** A board id: an uppercase prefix, a dash, digits. Anything else (lower case, a stray `;`, …) is refused. */
export function isTicketId(id: string): boolean {
  return /^[A-Z]+-\d+$/.test(id)
}

/** `text` wrapped so a shell takes it as one literal argument: close the quote, an escaped quote, reopen it. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * Whether `path` names a `.env*` file at any depth: the same files redact.ts reads as
 * secret-bearing (every name starting with `.env`, `.env.example` included, since a project may
 * keep a real value there). Step 8 never stages one, however it came to be changed (AVA1.1).
 */
export function isSecretsFile(path: string): boolean {
  return (path.split('/').pop() ?? path).startsWith('.env')
}

/** A path step8Commands may `git add`: repo-relative, no `..` segment, not under a folder nothing should ever commit, and not a `.env*` secrets file. */
export function isCommittable(path: string): boolean {
  if (path.startsWith('/')) return false
  if (path.split('/').includes('..')) return false
  if (path.startsWith('.work/') || path.startsWith('.static-analysis/')) return false
  if (isSecretsFile(path)) return false
  return true
}

export type Step8Commands = { ok: true; commands: string[]; excluded: string[] } | { ok: false }

/**
 * The ordered commands Step 8 (open the pull request) runs, as a progress note's Next action shows
 * them: `git add` the safe paths and commit, push the branch, open the PR with `gh`, then verify
 * with the PR URL. `ticket.id` gates the whole call (F23): an id that is not a board id builds no
 * command at all, since every command below cites it. A path that is absolute, holds a `..`
 * segment, sits under `.work/` or `.static-analysis/`, or is a `.env*` file is left out of the
 * commit and named in `excluded` for the caller's Open issues section.
 */
export function step8Commands(ticket: { id: string; title: string }, branch: string, paths: readonly string[], prBodyFile: string): Step8Commands {
  if (!isTicketId(ticket.id)) return { ok: false }
  const safe: string[] = []
  const excluded: string[] = []
  for (const path of paths) (isCommittable(path) ? safe : excluded).push(path)
  const addCommit = safe.length === 0 ? 'echo "nothing to commit"' : `git add -- ${safe.map(shellQuote).join(' ')} && git commit -m ${shellQuote(`${ticket.id}: static analysis`)}`
  // The branch is a validated slug (ticketBranch's own character set, GIT-001), never free text, so it is never shell-quoted.
  const commands = [
    addCommit,
    `git push -u origin ${branch}`,
    `gh pr create --base main --head ${branch} --title ${shellQuote(ticket.title)} --body-file ${prBodyFile}`,
    `~/.claude/skills/aspira-implementor/scripts/implementor.sh local ${ticket.id} --verify --pr-url <url>`,
  ]
  return { ok: true, commands, excluded }
}

/** Step 7 (static analysis), once per app directory. */
export function step7Command(id: string, app?: string): string {
  return ['~/.claude/skills/aspira-code-analyzer/scripts/code-analyzer.sh', 'local', id, ...(app === undefined ? [] : ['--app', app])].join(' ')
}

/** The command a verify step runs once Step 7 (static analysis) or Step 8's PR is confirmed. */
export function verifyCommand(skill: string, id: string, extra: readonly string[] = []): string {
  return [`~/.claude/skills/aspira-${skill}/scripts/${skill}.sh`, 'local', id, '--verify', ...extra].join(' ')
}

/** The command that puts a run on its dedicated branch, creating it from the current commit when it does not exist yet. */
export function switchCommand(branch: string, create: boolean): string {
  return create ? `git switch -c ${shellQuote(branch)}` : `git switch ${shellQuote(branch)}`
}
