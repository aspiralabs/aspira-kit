import type { Detection } from './analyzers.ts'
import { countBy, errors } from './diagnostics.ts'
import type { Rejection } from './guards.ts'
import { reportedCost, type Turn } from './ledger.ts'
import type { LoopResult } from './loop.ts'

export type ReportInput = {
  label: string
  where: 'host' | 'sandbox'
  result: LoopResult
  detection: Detection
  unavailable: string[]
  turns: Turn[]
  model: string
  timing: { prepareMs: number; loopMs: number; publishMs: number; totalMs: number }
  remote: { branch: string; commit: string | null; pushed: boolean; pullRequest: string | null } | null
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const money = (usd: number, reported: number, total: number) => (reported ? `$${usd.toFixed(4)}${reported < total ? ` (${reported}/${total} turns reported)` : ''}` : total ? 'unreported' : '$0.0000')

export function renderReport(input: ReportInput): string {
  const { result, turns } = input
  const before = countBy(input.result.initial, (d) => d.tool)
  const after = countBy(result.remaining, (d) => d.tool)
  const tools = [...new Set([...Object.keys(before), ...Object.keys(after), ...input.detection.analyzers.map((a) => a.tool)])].sort()
  const totals = turns.reduce((sum, turn) => { const c = reportedCost(turn); return { usd: sum.usd + (c ?? 0), reported: sum.reported + (c === null ? 0 : 1), input: sum.input + (turn.usage.inputTokens ?? 0), output: sum.output + (turn.usage.outputTokens ?? 0) } }, { usd: 0, reported: 0, input: 0, output: 0 })
  const remainingErrors = errors(result.remaining)
  const remainingWarnings = result.remaining.length - remainingErrors.length
  const lines = [
    '# Static analysis', '',
    `Repository: **${input.label}** (${input.where}). Status: **${result.status}**. Stop reason: ${result.reason}.`, '',
    `Ecosystems: ${input.detection.ecosystems.join(', ') || 'none'}${input.detection.packageManager ? ` (${input.detection.packageManager})` : ''}. Analyzers: ${input.detection.analyzers.filter((a) => a.check).map((a) => a.id).join(', ') || 'none'}.${input.unavailable.length ? ` Unavailable on this executor: ${input.unavailable.join(', ')}.` : ''}`, '',
    `Rounds: ${result.rounds.length}. Files edited by the model: ${result.editedFiles.length}. Rejected edits: ${result.rejected.length}. Remaining: ${remainingErrors.length} errors, ${remainingWarnings} warnings.`, '',
    `Reported model cost: **${money(totals.usd, totals.reported, turns.length)}** over ${turns.length} turns (${totals.input} input / ${totals.output} output tokens). Wall time: **${seconds(input.timing.totalMs)}** (prepare ${seconds(input.timing.prepareMs)}, loop ${seconds(input.timing.loopMs)}, publish ${seconds(input.timing.publishMs)}). Analyzer commands and model turns overlap within the loop; wall time is measured, not summed.`, '',
  ]
  if (input.remote) lines.push(`Branch: \`${input.remote.branch}\`${input.remote.commit ? ` at ${input.remote.commit.slice(0, 10)}` : ' (no commit: nothing changed)'}; ${input.remote.pushed ? 'pushed' : 'not pushed'}${input.remote.pullRequest ? `; pull request ${input.remote.pullRequest}` : ''}.`, '')
  lines.push('## By analyzer', '', '| Tool | Before | After |', '| --- | ---: | ---: |', ...tools.map((t) => `| ${t} | ${before[t] ?? 0} | ${after[t] ?? 0} |`), `| **total** | **${result.initial.length}** | **${result.remaining.length}** |`, '')
  lines.push('## By round', '', '| Round | Autofix | Diagnostics | Batches | Edits | Rejected | Unresolved | Wall time |', '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...result.rounds.map((r) => `| ${r.round} | ${r.autofix.map((a) => `${a.id}${a.exitCode ? ` (exit ${a.exitCode})` : ''}`).join(', ') || '—'} | ${r.targets} | ${r.batches} | ${r.edits} | ${r.rejected} | ${r.unresolved.length} | ${seconds(r.ms)} |`), '')
  if (turns.length) {
    const byRound = new Map<number, Turn[]>()
    for (const turn of turns) byRound.set(turn.round, [...(byRound.get(turn.round) ?? []), turn])
    lines.push('## Model turns by round', '', '| Round | Model | Turns | Input tokens | Output tokens | Reported cost |', '| ---: | --- | ---: | ---: | ---: | ---: |',
      ...[...byRound.entries()].map(([round, list]) => { const t = list.reduce((s, x) => { const c = reportedCost(x); return { usd: s.usd + (c ?? 0), rep: s.rep + (c === null ? 0 : 1), i: s.i + (x.usage.inputTokens ?? 0), o: s.o + (x.usage.outputTokens ?? 0) } }, { usd: 0, rep: 0, i: 0, o: 0 }); return `| ${round} | ${input.model} | ${list.length} | ${t.i} | ${t.o} | ${money(t.usd, t.rep, list.length)} |` }), '')
  }
  if (result.editedFiles.length) lines.push('## Files edited by the model', '', ...result.editedFiles.map((f) => `- ${f}`), '', 'Review this diff before merging: static analysis proves the checks pass, not that behavior is unchanged. No tests were run.', '')
  if (result.rejected.length) lines.push('## Rejected edits', '', ...summarize(result.rejected), '')
  if (result.remaining.length) lines.push('## Remaining diagnostics', '', ...result.remaining.slice(0, 200).map((d) => `- ${d.severity} ${d.tool} ${d.file}:${d.line ?? '?'} [${d.rule ?? '-'}] ${d.message}`), result.remaining.length > 200 ? `- … ${result.remaining.length - 200} more in diagnostics.json` : '', '')
  const unresolved = result.rounds.flatMap((r) => r.unresolved)
  if (unresolved.length) lines.push('## Left unresolved by the fixer', '', ...[...new Set(unresolved)].slice(0, 100).map((u) => `- ${u}`), '')
  if (result.problems.length) lines.push('## Problems', '', ...result.problems.map((p) => `- ${p.split('\n')[0]}`), '', 'Full output is in rounds.json.', '')
  if (input.detection.notes.length) lines.push('## Detection notes', '', ...input.detection.notes.map((n) => `- ${n}`), '')
  lines.push('Scope: static analyzers only. Reported cost covers model turns through the AI Gateway; unreported turns are not free. `diagnostics.json` holds the remaining diagnostics, `rounds.json` the per-round record and problems, `usage.json` every model turn, `calls.json` every prompt and result.', '')
  return lines.join('\n')
}

function summarize(rejected: Rejection[]): string[] {
  const counts = countBy(rejected, (r) => `${r.path} — ${r.reason}`)
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([key, n]) => `- ${key}${n > 1 ? ` (×${n})` : ''}`)
}
