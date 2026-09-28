// Pure helpers for the cloud checkout and publish tools. No eve imports.

export type Repo = { owner: string; name: string; url: string; label: string }

const GITHUB_HTTPS = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const SHORTHAND = /^([\w-][\w.-]*)\/([\w.-]+)$/

export const BRANCH_PREFIX = 'implement/'

export function parseRepo(input: string): Repo {
  const value = input.trim()
  const match = value.match(GITHUB_HTTPS) ?? value.match(GITHUB_SSH) ?? value.match(SHORTHAND)
  if (!match) throw new Error(`Not a GitHub repository (URL, git@ URL or owner/name): ${input}`)
  const [, owner, name] = match as [string, string, string]
  return { owner, name, url: `https://github.com/${owner}/${name}.git`, label: `${owner}/${name}` }
}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const authedUrl = (repo: Repo, token: string | undefined): string =>
  token ? repo.url.replace('https://', `https://x-access-token:${token}@`) : repo.url

export const redact = (text: string, token: string | undefined): string => (token ? text.replaceAll(token, '***') : text)

/** `implement/<slug>-<yyyymmdd-hhmmss>`; the slug comes from the feature name when given. */
export function branchName(feature: string | undefined, now = new Date()): string {
  const slug = (feature ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-').toLowerCase()
  return `${BRANCH_PREFIX}${slug ? `${slug}-` : ''}${stamp}`
}

/**
 * Runs inside the sandbox. Clones with the token, then resets `origin` to the plain URL so the
 * token never sits in .git/config where the model's shell could read it. Full history: the build
 * commits per wave and the plan's commit must be resolvable.
 */
export function cloneCommand(repo: Repo, token: string | undefined, root: string, branch: string, ref?: string): string {
  return [
    'set -e',
    `rm -rf ${shellQuote(root)}`,
    `git clone --quiet ${ref ? `--branch ${shellQuote(ref)} ` : ''}${shellQuote(authedUrl(repo, token))} ${shellQuote(root)}`,
    `cd ${shellQuote(root)}`,
    `git remote set-url origin ${shellQuote(repo.url)}`,
    `git checkout --quiet -b ${shellQuote(branch)}`,
    'git rev-parse HEAD',
  ].join('\n')
}

/** The only branch publish may push: the one checkout created, still checked out, under implement/. */
export function pushGuard(current: string, created: string): string | null {
  if (!created.startsWith(BRANCH_PREFIX)) return `Checkout branch ${created} is not under ${BRANCH_PREFIX}`
  if (current !== created) return `HEAD is on ${current}, not the run's branch ${created}; refusing to push`
  return null
}

export function pushCommand(repo: Repo, token: string | undefined, branch: string): string {
  return `git push --quiet ${shellQuote(authedUrl(repo, token))} ${shellQuote(`HEAD:refs/heads/${branch}`)}`
}
