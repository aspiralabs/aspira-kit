// The pre-run estimate the launcher prints before a cloud review: the diff size, the seats
// and the round cap, and a dollar range from the per-round averages of this package's
// previous cost.md files. Pure: the script feeds it the files and the diff.

/** One finished review, as its cost.md records it. */
export type CostSample = { label: string; costUsd: number; rounds: number; calls: number; changedLines: number | null }

/** The one cloud review before this change: the seed when there is no history yet. */
export const NOM4_SEED: CostSample = { label: 'nomnomzz PR #2, 2026-10-05, before the packet and the stopping rule', costUsd: 12.57, rounds: 4, calls: 328, changedLines: null }

const TOTAL_ROW = /^\| \*\*Total\*\* \| \| (\d[\d,]*) \|.*\| \*\*\$([\d.]+)\*\* \|$/m
const ROUNDS = /^Rounds: (\d+)/m
const CHANGED = /Changed lines: (\d[\d,]*)\./

const int = (s: string) => Number.parseInt(s.replaceAll(',', ''), 10)

/** A cost.md as a sample, or null when it is a --local file (no itemized cost) or an older layout without rounds. */
export function parseCostSample(costMd: string, label: string): CostSample | null {
  const total = costMd.match(TOTAL_ROW)
  const rounds = costMd.match(ROUNDS)
  if (total?.[1] === undefined || total[2] === undefined || rounds?.[1] === undefined) return null
  const costUsd = Number.parseFloat(total[2])
  const roundCount = int(rounds[1])
  if (!(costUsd > 0) || roundCount < 1) return null
  const changed = costMd.match(CHANGED)?.[1]
  return { label, costUsd, rounds: roundCount, calls: int(total[1]), changedLines: changed === undefined ? null : int(changed) }
}

export type Estimate = {
  changedLines: number
  seats: number
  maxRounds: number
  /** Dollars for one round, scaled to this diff where a sample knows its size. */
  perRound: { low: number; high: number }
  /** One round at the lowest per-round cost. */
  low: number
  /** Every round to the cap at the highest per-round cost. */
  high: number
  samples: CostSample[]
  seeded: boolean
}

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * The range: the cheapest sample's per-round cost for one round, up to the dearest sample's
 * per-round cost for every round to the cap. A sample that recorded its diff size is scaled
 * by this diff's size, within a factor of four either way; one that did not is taken as is.
 */
export function estimateCost(input: { changedLines: number; maxRounds: number; seats: number; samples: CostSample[] }): Estimate {
  const samples = input.samples.length > 0 ? input.samples : [NOM4_SEED]
  const perRound = samples.map((sample) => {
    const base = sample.costUsd / sample.rounds
    if (sample.changedLines === null || sample.changedLines === 0 || input.changedLines === 0) return base
    const factor = Math.min(4, Math.max(0.25, input.changedLines / sample.changedLines))
    return base * factor
  })
  const low = Math.min(...perRound)
  const high = Math.max(...perRound)
  return {
    changedLines: input.changedLines,
    seats: input.seats,
    maxRounds: input.maxRounds,
    perRound: { low, high },
    low,
    high: high * input.maxRounds,
    samples,
    seeded: input.samples.length === 0,
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`

/** The lines the launcher prints. Printed, not confirmed. */
export function renderEstimate(estimate: Estimate, source: string): string {
  const history = estimate.seeded
    ? `no previous cost.md in this package; seeded from ${estimate.samples[0]?.label ?? 'the seed'} (${usd(estimate.samples[0]?.costUsd ?? 0)} over ${estimate.samples[0]?.rounds ?? 0} rounds, ${estimate.samples[0]?.calls ?? 0} calls)`
    : `from ${estimate.samples.length} previous review${estimate.samples.length === 1 ? '' : 's'} in this package (${estimate.samples.map((s) => `${usd(s.costUsd)}/${s.rounds} rounds`).join(', ')})`
  const typical = median(estimate.samples.map((s) => s.costUsd / s.rounds)) * Math.min(2, estimate.maxRounds)
  return [
    `Estimate for ${source}:`,
    `  diff: ${estimate.changedLines.toLocaleString('en-US')} changed lines`,
    `  seats: ${estimate.seats} reviewers plus Quinn, up to ${estimate.maxRounds} round${estimate.maxRounds === 1 ? '' : 's'}`,
    `  cost: ${usd(estimate.low)} to ${usd(estimate.high)} (${usd(estimate.perRound.low)} to ${usd(estimate.perRound.high)} a round; a review that settles in two rounds is around ${usd(typical)})`,
    `  basis: ${history}`,
    '  --local costs this session\'s usage instead of the Gateway; --max-cost <USD> stops a cloud run at a dollar amount.',
  ].join('\n')
}

export type OneRoundCheck = { exceeds: boolean; oneRoundUsd: number; maxCostUsd: number | null; message: string }

/**
 * The budget pre-check: the dearest per-round cost the history predicts for this diff, against
 * the budget. A budget below one round would stop the run after its first stage with nothing to
 * show, so the launcher and pr-debator refuse before any model call and name both numbers.
 */
export function oneRoundCheck(input: { changedLines: number; seats: number; samples: CostSample[]; maxCostUsd: number | null }): OneRoundCheck {
  const estimate = estimateCost({ changedLines: input.changedLines, maxRounds: 1, seats: input.seats, samples: input.samples })
  const oneRoundUsd = estimate.perRound.high
  const exceeds = input.maxCostUsd !== null && oneRoundUsd > input.maxCostUsd
  const message = exceeds
    ? `Refusing to start: one round is estimated at ${usd(oneRoundUsd)} for ${input.changedLines.toLocaleString('en-US')} changed lines (${estimate.seeded ? 'seeded from the NOM-4 review' : `from ${estimate.samples.length} previous review${estimate.samples.length === 1 ? '' : 's'}`}), above the --max-cost budget of ${usd(input.maxCostUsd ?? 0)}. Raise the budget to at least ${usd(oneRoundUsd)}, or review a smaller diff. No model call was made.`
    : input.maxCostUsd === null
      ? `No budget; one round is estimated at ${usd(oneRoundUsd)}.`
      : `One round is estimated at ${usd(oneRoundUsd)}, within the --max-cost budget of ${usd(input.maxCostUsd)}.`
  return { exceeds, oneRoundUsd, maxCostUsd: input.maxCostUsd, message }
}
