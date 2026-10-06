// The search tool's command and its output cap, pure so they are tested without a sandbox.

/** Matches are cut past this many characters: a seat that needs more should narrow the pattern. */
export const MAX_SEARCH_CHARS = 20_000
/** Lines of context either side of a match. */
export const SEARCH_CONTEXT_LINES = 2

const EXCLUDED_DIRS = ['.git', 'node_modules', 'dist', 'build', '.next', '.output', '.turbo', 'coverage', '.work', '.eve']

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * `grep -rn` with two lines of context over the tree, as a shell command. Globs become
 * `--include` patterns on the file name. The pattern is an extended regular expression.
 */
export function searchCommand(pattern: string, globs: string[] | undefined, root: string): string {
  const includes = (globs ?? []).filter((glob) => glob.trim() !== '').map((glob) => `--include=${shellQuote(glob.trim())}`)
  const excludes = EXCLUDED_DIRS.map((dir) => `--exclude-dir=${dir}`)
  return `cd ${shellQuote(root)} && grep -rnI -E -C ${SEARCH_CONTEXT_LINES} ${[...excludes, ...includes].join(' ')} -e ${shellQuote(pattern)} . ; test $? -le 1`
}

/** The matches, with the leading `./` dropped and the output cut past the cap with a pointer. */
export function formatSearchOutput(stdout: string, maxChars: number = MAX_SEARCH_CHARS): { text: string; truncated: boolean; empty: boolean } {
  const text = stdout
    .split('\n')
    .map((line) => line.replace(/^\.\//, ''))
    .join('\n')
    .trimEnd()
  if (text === '') return { text: 'No matches.', truncated: false, empty: true }
  if (text.length <= maxChars) return { text: `${text}\n`, truncated: false, empty: false }
  const cut = text.slice(0, maxChars)
  const kept = cut.slice(0, cut.lastIndexOf('\n') + 1)
  return { text: `${kept}… cut at ${maxChars.toLocaleString('en-US')} characters. Narrow the pattern or add globs.\n`, truncated: true, empty: false }
}
