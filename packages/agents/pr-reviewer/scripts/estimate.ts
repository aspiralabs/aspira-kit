import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { estimateCost, parseCostSample, renderEstimate } from '../agent/lib/estimate.ts'
import { defaultGithubToken, fetchPrDiff, localDiff, resolveLocalBranch } from '../agent/lib/local-source.ts'
import { parsePrSource, patchStats } from '../agent/lib/pr.ts'
import { DEFAULT_MAX_ROUNDS, SEATS } from '../agent/lib/review.ts'

// The estimate the launcher prints before a cloud run: the diff size from the source itself,
// and the dollar range from the cost.md files of this package's previous reviews. No model call.
const usage = 'Usage: pnpm review:estimate <github-pr | absolute-repo-path> [--branch B] [--base main] [--max-rounds N]'
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function history(): Promise<ReturnType<typeof parseCostSample>[]> {
  const reviews = join(packageDir, 'reviews')
  const names = (await readdir(reviews).catch(() => [])).sort()
  const samples = []
  for (const name of names) {
    const text = await readFile(join(reviews, name, 'cost.md'), 'utf8').catch(() => null)
    if (text !== null) samples.push(parseCostSample(text, name))
  }
  return samples
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { branch: { type: 'string' }, base: { type: 'string' }, 'max-rounds': { type: 'string' } },
  })
  const [source, ...extra] = positionals
  if (source === undefined || extra.length > 0) throw new Error(usage)
  const maxRounds = values['max-rounds'] === undefined ? DEFAULT_MAX_ROUNDS : Number(values['max-rounds'])
  const parsed = parsePrSource(source)
  let patch: string
  if (parsed.kind === 'github') {
    const pr = { owner: parsed.owner, name: parsed.name, number: parsed.number }
    patch = (await fetchPrDiff(pr, await defaultGithubToken(), fetch)).patch
  } else {
    const branch = await resolveLocalBranch(parsed.path, values.branch, values.base)
    patch = (await localDiff(branch, [])).patch
  }
  const stats = patchStats(patch, 0)
  const samples = (await history()).flatMap((sample) => (sample === null ? [] : [sample]))
  console.log(renderEstimate(estimateCost({ changedLines: stats.additions + stats.deletions, maxRounds, seats: SEATS.length, samples }), parsed.label))
} catch (error) {
  console.error(`pr-reviewer estimate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
