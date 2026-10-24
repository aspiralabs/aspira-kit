import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FlowRefused } from './ticket-flow.ts'
import { checkParentRun, encodeTrace, listsTelemetry, reserveRunId, statusCode, statusWord, writeTelemetry, type SpanInput } from './telemetry.ts'
import { USAGE_SCOPES, readSessionUsage, readUsageSource, subagentSpans } from './telemetry-sources.ts'

// KIT-19 telemetry module, at its own seam: the span tree in, the OTLP JSON document out; the
// usage-file readers in, span groups out; run-id reservation and the telemetry file on disk; and
// the --parent-run check against a build-feature state.json. Time is injected as fixed ISO strings
// and epoch ms; nothing reads the clock. Every fixture lives in a mkdtemp folder per test.

// ---------------------------------------------------------------------------------------------
// The OTLP/JSON shape the file must have, validated the same way a reader of the file would.
// ---------------------------------------------------------------------------------------------

type AnyValue = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: AnyValue[] } }
const decimal = z.string().regex(/^\d+$/)
const anyValueSchema: z.ZodType<AnyValue> = z.lazy(() =>
  z.strictObject({
    stringValue: z.string().optional(),
    intValue: decimal.optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
    arrayValue: z.strictObject({ values: z.array(anyValueSchema) }).optional(),
  }),
)
const keyValueSchema = z.strictObject({ key: z.string().min(1), value: anyValueSchema })
const spanSchema = z.looseObject({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: decimal,
  endTimeUnixNano: decimal,
  attributes: z.array(keyValueSchema),
  status: z.looseObject({ code: z.number().int(), message: z.string().optional() }),
})
type Span = z.infer<typeof spanSchema>
const traceSchema = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: z.array(keyValueSchema) }),
      scopeSpans: z.array(z.object({ scope: z.object({ name: z.string() }), spans: z.array(spanSchema) })),
    }),
  ),
})
type Trace = z.infer<typeof traceSchema>

/** The document as a file reader sees it: serialized, parsed back and validated. */
const roundTrip = (document: unknown): Trace => traceSchema.parse(JSON.parse(JSON.stringify(document)))
const spansOf = (trace: Trace): Span[] => trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
const attr = (span: Span, key: string): AnyValue | undefined => span.attributes.find((item) => item.key === key)?.value
const notMeasured = (span: Span): string[] => (attr(span, 'aspira.not_measured')?.arrayValue?.values ?? []).map((value) => value.stringValue ?? '')
function spanNamed(trace: Trace, name: string): Span {
  const span = spansOf(trace).find((item) => item.name === name)
  if (!span) throw new Error(`no span named ${name}`)
  return span
}
const asMs = (value: string | number): number => (typeof value === 'number' ? value : Date.parse(value))

// ---------------------------------------------------------------------------------------------
// Fixed times and fixtures.
// ---------------------------------------------------------------------------------------------

const T0 = '2026-10-15T09:00:00.000Z'
const T0_MS = 1792054800000
const T10 = '2026-10-15T09:10:00.000Z'
const T10_MS = 1792055400000
const at = (minutes: number, seconds = 0): string => new Date(T0_MS + minutes * 60_000 + seconds * 1000).toISOString()
const RESOURCE = { kitVersion: '0.7.0', ticketId: 'KIT-19', runId: 'run-20261015T090000Z', mode: 'local' as const }
const OPUS = 'anthropic/claude-opus-5.5'
const LUNA = 'openai/gpt-6-luna'
const SONNET = 'anthropic/claude-sonnet-5'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'telemetry-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeJson(file: string, value: unknown): Promise<string> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
  return file
}

/** Set a file's mtime to a fixed instant (the reader's staleness check compares against it). */
async function touch(file: string, iso: string): Promise<void> {
  const when = new Date(iso)
  await utimes(file, when, when)
}

/** A groomer trace/usage.json: two phases, three turns, cost as number and numeric string, one turn without outputTokens. */
const groomerUsage = {
  scope: 'groomer facts and rounds',
  turns: [
    { phase: 'facts', model: OPUS, turn: 1, startedMs: 1000, durationMs: 4000, status: 'completed', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, providerMetadata: { gateway: { cost: 0.5 } }, toolCalls: [{ toolName: 'search' }, { toolName: 'read' }] },
    { phase: 'facts', model: OPUS, turn: 2, startedMs: 6000, durationMs: 2000, status: 'completed', usage: { inputTokens: 50, totalTokens: 60 }, providerMetadata: { gateway: { cost: '0.25' } }, toolCalls: [] },
    { phase: 'round', model: LUNA, turn: 3, startedMs: 9000, durationMs: 1000, status: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, providerMetadata: { gateway: { cost: 0.125 } }, toolCalls: [] },
  ],
}

/** A code-analyzer usage.json (ledger.ts Turn[]): turns in rounds 1 and 2. */
const ledgerUsage = {
  scope: 'code-analyzer fix rounds',
  model: SONNET,
  turns: [
    { round: 1, batch: 1, model: SONNET, turn: 1, startedMs: 1000, durationMs: 2000, status: 'completed', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, providerMetadata: { gateway: { cost: 0.25 } }, toolCalls: [{ toolName: 'edit' }] },
    { round: 1, batch: 2, model: SONNET, turn: 2, startedMs: 4000, durationMs: 1000, status: 'completed', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 }, providerMetadata: { gateway: { cost: 0.125 } }, toolCalls: [] },
    { round: 2, batch: 1, model: SONNET, turn: 3, startedMs: 8000, durationMs: 1000, status: 'completed', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 }, providerMetadata: { gateway: { cost: 0.0625 } }, toolCalls: [] },
  ],
}

/** pr-reviewer usage.jsonl: ava with startedAt, ava with only at + durationMs and costUsd null, quinn with neither startedAt nor durationMs. */
const usageLines = [
  { agent: 'ava', sessionId: 'sess-ava-1', turnId: 'turn-ava-1', stepIndex: 0, at: at(1, 10), startedAt: at(1), durationMs: 10_000, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50, costUsd: 0.5 },
  { agent: 'ava', sessionId: 'sess-ava-1', turnId: 'turn-ava-2', stepIndex: 1, at: at(2), durationMs: 5000, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
  { agent: 'quinn', sessionId: 'sess-quinn-1', turnId: 'turn-quinn-1', stepIndex: 0, at: at(3), inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
]
const PR_MODELS = { ava: OPUS, quinn: LUNA }

async function writeLines(file: string, lines: unknown[]): Promise<string> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}

type SourceResult = Awaited<ReturnType<typeof readUsageSource>>
function groupsOf(result: SourceResult): SpanInput[] {
  if (!('groups' in result)) throw new Error(`expected groups, got gap ${result.gap}`)
  return result.groups
}
function groupNamed(groups: SpanInput[], name: string): SpanInput {
  const group = groups.find((item) => item.name === name)
  if (!group) throw new Error(`no group named ${name}`)
  return group
}

// ---------------------------------------------------------------------------------------------

describe('telemetry', () => {
  describe('encodeTrace writes OTLP JSON (T1, F2)', () => {
    const tree: SpanInput = {
      name: 'spec-writer',
      kind: 'hand-run',
      start: T0,
      end: T10,
      status: 'ready',
      children: [
        { name: 'explore', kind: 'phase', start: T0, end: at(3), status: 'completed' },
        { name: 'draft', kind: 'phase', start: at(3), end: at(9), status: 'completed', children: [{ name: 'subagent-1', kind: 'subagent', start: at(4), end: at(6) }] },
      ],
    }

    it('holds the four spans of the tree in one resourceSpans/scopeSpans list', () => {
      expect(spansOf(roundTrip(encodeTrace(tree, RESOURCE)))).toHaveLength(4)
    })

    it('gives every span one shared 32-hex trace id and its own 16-hex span id', () => {
      const spans = spansOf(roundTrip(encodeTrace(tree, RESOURCE)))
      const traceIds = new Set(spans.map((span) => span.traceId))
      const spanIds = spans.map((span) => span.spanId)
      expect({ traceIds: traceIds.size, traceId: /^[0-9a-f]{32}$/.test([...traceIds][0] ?? ''), spanIds: spanIds.every((id) => /^[0-9a-f]{16}$/.test(id)), unique: new Set(spanIds).size }).toEqual({ traceIds: 1, traceId: true, spanIds: true, unique: 4 })
    })

    it('writes start and end as decimal nanosecond strings', () => {
      const root = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'spec-writer')
      expect([root.startTimeUnixNano, root.endTimeUnixNano]).toEqual(['1792054800000000000', '1792055400000000000'])
    })

    it('writes every intValue as a decimal string', () => {
      const raw: unknown = JSON.parse(JSON.stringify(encodeTrace(tree, RESOURCE)))
      const ints: unknown[] = []
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value !== null && typeof value === 'object') {
          for (const [key, inner] of Object.entries(value)) {
            if (key === 'intValue') ints.push(inner)
            else walk(inner)
          }
        }
      }
      walk(raw)
      expect(ints.length > 0 && ints.every((value) => typeof value === 'string' && /^\d+$/.test(value))).toBe(true)
    })

    it('leaves the root without a parent and points every other span at a span in the file', () => {
      const spans = spansOf(roundTrip(encodeTrace(tree, RESOURCE)))
      const ids = new Set(spans.map((span) => span.spanId))
      const root = spans.find((span) => span.name === 'spec-writer')
      const others = spans.filter((span) => span !== root)
      expect({ rootParent: root?.parentSpanId, linked: others.every((span) => span.parentSpanId !== undefined && ids.has(span.parentSpanId)) }).toEqual({ rootParent: undefined, linked: true })
    })

    it('puts exactly service name, kit version, ticket id, run id, mode and schema 1 on the resource', () => {
      const resource = roundTrip(encodeTrace(tree, RESOURCE)).resourceSpans[0]?.resource.attributes ?? []
      expect(Object.fromEntries(resource.map((item) => [item.key, item.value]))).toEqual({
        'service.name': { stringValue: 'aspira-kit' },
        'service.version': { stringValue: '0.7.0' },
        'aspira.ticket.id': { stringValue: 'KIT-19' },
        'aspira.run.id': { stringValue: 'run-20261015T090000Z' },
        'aspira.mode': { stringValue: 'local' },
        'aspira.telemetry.schema': { intValue: '1' },
      })
    })
  })

  describe('measured and not-measured values (T2, F3, F21)', () => {
    const tree: SpanInput = {
      name: 'planner',
      kind: 'hand-run',
      start: T0,
      end: T10,
      status: 'ready',
      usage: { model: OPUS, inputTokens: 100, outputTokens: 50, totalTokens: 150, toolCalls: 1, costUsd: 0.25 },
      children: [
        { name: 'research', kind: 'phase', start: at(1), end: at(4), status: 'completed', usage: { model: OPUS, inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 2, costUsd: 0.01 } },
        { name: 'planning', kind: 'phase', start: at(4), end: at(9), status: 'completed', usage: { model: OPUS, inputTokens: null, outputTokens: null, totalTokens: 0, toolCalls: null, costUsd: null } },
      ],
    }

    it('gives every span its start, end and duration in ms', () => {
      const research = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'research')
      expect({ start: research.startTimeUnixNano, end: research.endTimeUnixNano, duration: attr(research, 'aspira.duration_ms') }).toEqual({ start: '1792054860000000000', end: '1792055040000000000', duration: { intValue: '180000' } })
    })

    it('writes a reported 0 as 0 and does not list it as not measured', () => {
      const planning = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'planning')
      expect({ total: attr(planning, 'aspira.tokens.total'), listed: notMeasured(planning).includes('aspira.tokens.total') }).toEqual({ total: { intValue: '0' }, listed: false })
    })

    it('leaves an unmeasured cost out and lists it as not measured', () => {
      const planning = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'planning')
      expect({ cost: attr(planning, 'aspira.cost_usd'), listed: notMeasured(planning).includes('aspira.cost_usd') }).toEqual({ cost: undefined, listed: true })
    })

    it('never both writes a key and lists it as not measured', () => {
      const spans = spansOf(roundTrip(encodeTrace(tree, RESOURCE)))
      const clashes = spans.flatMap((span) => notMeasured(span).filter((key) => attr(span, key) !== undefined).map((key) => `${span.name}:${key}`))
      expect(clashes).toEqual([])
    })

    it('sums self and descendants into the inclusive totals and marks the parent partial', () => {
      const root = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'planner')
      expect({ total: attr(root, 'aspira.tokens.total_inclusive'), cost: attr(root, 'aspira.cost_usd_inclusive')?.doubleValue, partial: attr(root, 'aspira.partial') }).toEqual({ total: { intValue: '165' }, cost: expect.closeTo(0.26, 10), partial: { boolValue: true } })
    })
  })

  describe('privacy (T3, F4)', () => {
    const PROMPT = 'Please summarise the secret customer list'
    const RESPONSE = 'Here is the secret customer list summary'
    const TOOL_ARG = 'customers-private.csv'
    const TOOL_RESULT = 'alice@example.com,bob@example.com'
    const SESSION_ID = 'sess-7f3a9c1e-private'
    const RESULT_LINE = 'spec-writer ready: wrote spec.md after reading customers-private.csv'
    const ERROR = 'ENOENT: no such file or directory, open /Users/x'

    async function serializedRun(): Promise<{ text: string; trace: Trace }> {
      const usageFile = await writeJson(join(dir, 'export', 'trace', 'usage.json'), {
        scope: 'spec-writer draft and review',
        turns: [
          { phase: '/Users/x/secret phase', model: '/Users/x/y', turn: 1, startedMs: 0, durationMs: 1000, status: 'completed', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, providerMetadata: { gateway: { cost: 0.01, path: '/Users/x/gateway' }, sessionId: SESSION_ID }, finishReason: ERROR, messages: [{ role: 'user', content: PROMPT }], text: RESPONSE, toolCalls: [{ toolName: 'read_file', args: { path: `/Users/x/${TOOL_ARG}` } }], toolResults: [{ result: TOOL_RESULT }], sessionId: SESSION_ID },
          { phase: 'draft', model: OPUS, turn: 2, startedMs: 2000, durationMs: 1000, status: 'completed', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 }, providerMetadata: { gateway: { cost: 0.02 } }, text: RESPONSE, toolCalls: [], toolResults: [] },
        ],
      })
      await touch(usageFile, at(5))
      const sessionFile = await writeJson(join(dir, 'export', 'trace', 'session-usage.json'), {
        runId: RESOURCE.runId,
        subagents: [{ label: 'Read /Users/x/a.ts and fix ENOENT', startedAt: at(6), endedAt: at(7), totalTokens: 100, toolUses: 3, wallMs: 60_000, model: OPUS, sessionId: SESSION_ID, resultLine: RESULT_LINE }],
      })
      const source = await readUsageSource(usageFile, { kind: 'usage.json', skill: 'spec-writer', start: T0, end: T10 })
      const session = await readSessionUsage(sessionFile)
      if (!('usage' in session)) throw new Error(`session usage gap ${session.gap}`)
      const tree: SpanInput = { name: 'spec-writer', kind: 'hand-run', start: T0, end: T10, status: ERROR, children: [...groupsOf(source), ...subagentSpans(session.usage, { start: T0, end: T10 })] }
      const text = JSON.stringify(encodeTrace(tree, RESOURCE))
      return { text, trace: roundTrip(JSON.parse(text)) }
    }

    it('contains no message text, tool arguments, tool results, paths, error text, session id or result line', async () => {
      const { text } = await serializedRun()
      const leaked = [PROMPT, RESPONSE, TOOL_ARG, TOOL_RESULT, '/Users/', 'ENOENT', SESSION_ID, 'resultLine', RESULT_LINE].filter((needle) => text.includes(needle))
      expect(leaked).toEqual([])
    })

    it('writes a path-like phase as other and a free-text subagent label as subagent-1', async () => {
      const { trace } = await serializedRun()
      const names = spansOf(trace).map((span) => span.name)
      expect({ other: names.includes('other'), subagent: names.includes('subagent-1') }).toEqual({ other: true, subagent: true })
    })

    it('writes a path-like model as other and keeps a model id', async () => {
      const { trace } = await serializedRun()
      const models = spansOf(trace).map((span) => attr(span, 'aspira.model')?.stringValue).filter((model) => model !== undefined)
      expect({ other: models.includes('other'), opus: models.includes(OPUS) }).toEqual({ other: true, opus: true })
    })

    it('sets no status.message on any span', async () => {
      const { trace } = await serializedRun()
      expect(spansOf(trace).filter((span) => 'message' in span.status)).toEqual([])
    })
  })

  describe('status words and codes (T4, F20)', () => {
    it('gives a code-analyzer step that exported partial and stopped aspira.status partial and code ERROR', () => {
      const tree: SpanInput = { name: 'build-feature', kind: 'build-feature', start: T0, end: T10, status: 'stopped', children: [{ name: 'code-analyzer', kind: 'step', start: at(1), end: at(9), status: 'partial', verdict: 'stop' }] }
      const step = spanNamed(roundTrip(encodeTrace(tree, RESOURCE)), 'code-analyzer')
      expect({ status: attr(step, 'aspira.status'), code: step.status.code }).toEqual({ status: { stringValue: 'partial' }, code: 2 })
    })

    it.each([
      ['step', 'partial', 'stop', 'ERROR'],
      ['step', 'clean', 'continue', 'OK'],
      ['hand-run', 'ready', undefined, 'OK'],
      ['hand-run', 'complete', undefined, 'OK'],
      ['hand-run', 'clean', undefined, 'OK'],
      ['hand-run', 'confirmed', undefined, 'OK'],
      ['hand-run', 'incomplete', undefined, 'ERROR'],
      ['hand-run', 'refused', undefined, 'ERROR'],
      ['hand-run', 'needs-author', undefined, 'UNSET'],
      ['hand-run', 'partial', undefined, 'UNSET'],
      ['hand-run', 'stopped', undefined, 'UNSET'],
      ['build-feature', 'finished', undefined, 'OK'],
      ['build-feature', 'stopped', undefined, 'ERROR'],
      ['build-feature', 'replaced', undefined, 'UNSET'],
      ['turn', 'completed', undefined, 'OK'],
      ['turn', 'failed', undefined, 'ERROR'],
      ['turn', 'running', undefined, 'UNSET'],
      ['fix', 'complete', undefined, 'OK'],
    ] as const)('maps a %s ending %s (verdict %s) to %s', (kind, word, verdict, code) => {
      expect({ word: statusWord(word), code: statusCode(kind, word, verdict) }).toEqual({ word, code })
    })

    it('writes an unknown word as other with code UNSET', () => {
      expect({ word: statusWord('exploded-mid-flight'), code: statusCode('hand-run', 'exploded-mid-flight') }).toEqual({ word: 'other', code: 'UNSET' })
    })
  })

  describe('trace/usage.json reader (T5, F10, F12)', () => {
    const interval = { kind: 'usage.json' as const, skill: 'groomer' as const, start: T0, end: T10 }

    async function groomerGroups(): Promise<SpanInput[]> {
      const file = await writeJson(join(dir, 'groom', 'trace', 'usage.json'), groomerUsage)
      await touch(file, at(5))
      return groupsOf(await readUsageSource(file, interval))
    }

    it('sums input, output, total, cost and tool-call entries per phase/model group', async () => {
      const groups = await groomerGroups()
      const view = (name: string) => {
        const usage = groupNamed(groups, name).usage
        return { model: usage?.model, input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens, tools: usage?.toolCalls, cost: usage?.costUsd }
      }
      expect({ count: groups.length, facts: view('facts'), round: view('round') }).toEqual({
        count: 2,
        facts: { model: OPUS, input: 150, output: 20, total: 180, tools: 2, cost: 0.75 },
        round: { model: LUNA, input: 10, output: 5, total: 15, tools: 0, cost: 0.125 },
      })
    })

    it('marks the group with a turn missing its output partial', async () => {
      const facts = groupNamed(await groomerGroups(), 'facts')
      expect({ output: facts.usage?.outputTokens, partial: facts.attributes?.['aspira.partial'] }).toEqual({ output: 20, partial: true })
    })

    it('anchors groups at the run start with time basis model+tools, partial and the groomer usage scope', async () => {
      const groups = await groomerGroups()
      const scope = USAGE_SCOPES.groomer
      const views = groups.map((group) => ({ anchored: group.attributes?.['aspira.time.anchored'], basis: group.attributes?.['aspira.time_basis'], partial: group.attributes?.['aspira.partial'], scope: group.attributes?.['aspira.usage_scope'] }))
      expect({ scopeNamed: typeof scope === 'string' && scope.length > 0, views }).toEqual({ scopeNamed: true, views: [0, 1].map(() => ({ anchored: true, basis: 'model+tools', partial: true, scope })) })
    })

    it('reports empty, invalid, missing and stale files as gaps', async () => {
      const empty = await writeJson(join(dir, 'empty', 'usage.json'), { scope: 'groomer facts and rounds', turns: [] })
      await touch(empty, at(5))
      const invalid = join(dir, 'invalid', 'usage.json')
      await mkdir(dirname(invalid), { recursive: true })
      await writeFile(invalid, '{"scope": "groomer", "turns": "not a list"')
      await touch(invalid, at(5))
      const stale = await writeJson(join(dir, 'stale', 'usage.json'), groomerUsage)
      await touch(stale, '2026-10-15T08:00:00.000Z')
      const gaps = await Promise.all([empty, invalid, join(dir, 'missing', 'usage.json'), stale].map(async (file) => {
        const result = await readUsageSource(file, interval)
        return 'gap' in result ? result.gap : 'groups'
      }))
      expect(gaps).toEqual(['empty', 'invalid', 'missing', 'stale'])
    })
  })

  describe('code-analyzer usage.json and pr-reviewer usage.jsonl readers (T6, F10)', () => {
    const parent = { start: T0, end: T10 }

    async function ledgerGroups(): Promise<SpanInput[]> {
      const file = await writeJson(join(dir, '.static-analysis', 'usage.json'), ledgerUsage)
      await touch(file, at(5))
      return groupsOf(await readUsageSource(file, { kind: 'ledger', skill: 'code-analyzer', ...parent }))
    }

    async function lineGroups(): Promise<SpanInput[]> {
      const file = await writeLines(join(dir, 'pr-review', 'usage.jsonl'), usageLines)
      await touch(file, at(5))
      return groupsOf(await readUsageSource(file, { kind: 'usage.jsonl', skill: 'pr-reviewer', models: PR_MODELS, ...parent }))
    }

    it('groups code-analyzer turns per round with the ledger model', async () => {
      const groups = await ledgerGroups()
      expect(groups.map((group) => ({ name: group.name, model: group.usage?.model, input: group.usage?.inputTokens }))).toEqual([
        { name: 'round-1', model: SONNET, input: 140 },
        { name: 'round-2', model: SONNET, input: 20 },
      ])
    })

    it('groups pr-reviewer lines per agent with the mapped model, separate cache tokens, no tool count and partial cost', async () => {
      const ava = groupNamed(await lineGroups(), 'ava')
      expect({
        model: ava.usage?.model,
        input: ava.usage?.inputTokens,
        output: ava.usage?.outputTokens,
        total: ava.usage?.totalTokens,
        cacheRead: ava.usage?.cacheRead,
        cacheWrite: ava.usage?.cacheWrite,
        tools: ava.usage?.toolCalls ?? null,
        cost: ava.usage?.costUsd,
        partial: ava.attributes?.['aspira.partial'],
        basis: ava.attributes?.['aspira.time_basis'],
      }).toEqual({ model: OPUS, input: 1500, output: 300, total: 1800, cacheRead: 300, cacheWrite: 50, tools: null, cost: 0.5, partial: true, basis: 'model-only' })
    })

    it('lists the pr-reviewer tool-call count as not measured', async () => {
      const groups = await lineGroups()
      const trace = roundTrip(encodeTrace({ name: 'pr-reviewer', kind: 'hand-run', ...parent, status: 'complete', children: groups }, RESOURCE))
      expect(notMeasured(spanNamed(trace, 'ava')).includes('aspira.tool_calls')).toBe(true)
    })

    it('anchors only the line with neither startedAt nor a duration, at the parent start', async () => {
      const groups = await lineGroups()
      const ava = groupNamed(groups, 'ava')
      const quinn = groupNamed(groups, 'quinn')
      expect({ ava: ava.attributes?.['aspira.time.anchored'] ?? false, quinnAnchored: quinn.attributes?.['aspira.time.anchored'], quinnStart: asMs(quinn.start), avaStart: asMs(ava.start), avaEnd: asMs(ava.end) }).toEqual({ ava: false, quinnAnchored: true, quinnStart: T0_MS, avaStart: Date.parse(at(1)), avaEnd: Date.parse(at(2)) })
    })

    it('keeps every group inside the parent interval', async () => {
      const groups = [...(await ledgerGroups()), ...(await lineGroups())]
      expect(groups.filter((group) => asMs(group.start) < T0_MS || asMs(group.end) > T10_MS).map((group) => group.name)).toEqual([])
    })
  })

  describe('run id reservation and the telemetry file (T7, F13)', () => {
    const STARTED = '2026-10-15T09:00:00.123Z'
    const pendingOf = (id: string) => join(dir, '.local', 'telemetry', `${id}.pending`)
    const documentFor = (runId: string, end: string) => encodeTrace({ name: 'planner', kind: 'hand-run', start: STARTED, end, status: 'ready' }, { ...RESOURCE, runId })

    it('reserves distinct ids for two runs started in the same second, each with a .pending marker', async () => {
      const first = await reserveRunId(dir, STARTED)
      const second = await reserveRunId(dir, STARTED)
      expect({ ids: [first, second], markers: [existsSync(pendingOf(first)), existsSync(pendingOf(second))] }).toEqual({ ids: ['run-20261015T090000Z', 'run-20261015T090000Z-1'], markers: [true, true] })
    })

    it('writes telemetry/<run-id>.json named by the resource run id and removes its .pending marker', async () => {
      const id = await reserveRunId(dir, STARTED)
      const result = await writeTelemetry(dir, id, documentFor(id, T10))
      const written = roundTrip(JSON.parse(await readFile(join(dir, 'telemetry', 'run-20261015T090000Z.json'), 'utf8')))
      const runId = written.resourceSpans[0]?.resource.attributes.find((item) => item.key === 'aspira.run.id')?.value.stringValue
      expect({ ok: result.ok, runId, pending: existsSync(pendingOf(id)), files: await readdir(join(dir, 'telemetry')) }).toEqual({ ok: true, runId: 'run-20261015T090000Z', pending: false, files: ['run-20261015T090000Z.json'] })
    })

    it('refuses a second write for the same run id and leaves the first file byte-identical', async () => {
      const id = await reserveRunId(dir, STARTED)
      await writeTelemetry(dir, id, documentFor(id, T10))
      const file = join(dir, 'telemetry', 'run-20261015T090000Z.json')
      const before = await readFile(file)
      const second = await writeTelemetry(dir, id, documentFor(id, at(20)))
      expect({ ok: second.ok, same: (await readFile(file)).equals(before) }).toEqual({ ok: false, same: true })
    })
  })

  describe('session usage report and subagent spans (T8, F9, F12)', () => {
    const parent = { start: T0, end: T10 }
    const report = {
      runId: RESOURCE.runId,
      subagents: [
        { label: 'Explore the repository', startedAt: at(1), endedAt: at(3), totalTokens: 5000, toolUses: 12, wallMs: 118_000, model: OPUS },
        { label: 'Draft the plan', wallMs: 30_000 },
        { label: 'Check the tests', startedAt: at(4), endedAt: at(5), totalTokens: '4000', toolUses: 2 },
      ],
    }

    async function spans(): Promise<SpanInput[]> {
      const session = await readSessionUsage(await writeJson(join(dir, 'export', 'trace', 'session-usage.json'), report))
      if (!('usage' in session)) throw new Error(`session usage gap ${session.gap}`)
      return subagentSpans(session.usage, parent)
    }
    async function encoded(): Promise<Trace> {
      return roundTrip(encodeTrace({ name: 'planner', kind: 'hand-run', ...parent, status: 'ready', children: await spans() }, RESOURCE))
    }

    it('makes one span per subagent', async () => {
      expect((await spans()).map((span) => span.name)).toEqual(['subagent-1', 'subagent-2', 'subagent-3'])
    })

    it('records total tokens, tool uses with their basis and the reported wall time, with input/output not measured', async () => {
      const span = spanNamed(await encoded(), 'subagent-1')
      expect({
        total: attr(span, 'aspira.tokens.total'),
        tools: attr(span, 'aspira.tool_calls'),
        basis: attr(span, 'aspira.tool_count_basis'),
        wall: attr(span, 'aspira.reported_wall_ms'),
        unmeasured: ['aspira.tokens.input', 'aspira.tokens.output'].every((key) => notMeasured(span).includes(key)),
      }).toEqual({ total: { intValue: '5000' }, tools: { intValue: '12' }, basis: { stringValue: 'agent tool uses' }, wall: { intValue: '118000' }, unmeasured: true })
    })

    it('anchors a duration-only subagent at the parent start', async () => {
      const span = groupNamed(await spans(), 'subagent-2')
      expect({ start: asMs(span.start), end: asMs(span.end), anchored: span.attributes?.['aspira.time.anchored'] }).toEqual({ start: T0_MS, end: T0_MS + 30_000, anchored: true })
    })

    it('keeps a malformed entry as a span with every number not measured and gap invalid', async () => {
      const span = spanNamed(await encoded(), 'subagent-3')
      const numbers = ['aspira.tokens.total', 'aspira.tokens.input', 'aspira.tokens.output', 'aspira.tool_calls', 'aspira.cost_usd']
      expect({ present: numbers.filter((key) => attr(span, key) !== undefined), listed: numbers.every((key) => notMeasured(span).includes(key)), gap: attr(span, 'aspira.gap') }).toEqual({ present: [], listed: true, gap: { stringValue: 'invalid' } })
    })

    it('reports a missing session usage file as gap missing', async () => {
      expect(await readSessionUsage(join(dir, 'nowhere', 'session-usage.json'))).toEqual({ gap: 'missing' })
    })
  })

  describe('--parent-run check (T9, F6)', () => {
    const RUN = 'run-20261015T090000Z'
    const N1 = '6f1c7a52-3b9e-4c1d-9a7e-2f5b8c4d1e01'
    const N0 = '6f1c7a52-3b9e-4c1d-9a7e-2f5b8c4d1e00'
    const OTHER = '0b2d4e6f-8a1c-4e3b-9d5f-7a9c1e3b5d7f'

    beforeEach(async () => {
      await writeJson(join(dir, '.local', 'build-feature', 'state.json'), {
        runs: [{ runId: RUN, command: '/aspira-build-feature KIT-19', startedAt: T0, endedAt: null, ended: null, mode: 'local' }],
        inProgress: { runId: RUN, startedAt: T0 },
        steps: [{ step: 'spec-writer', runId: RUN, command: '/aspira-spec-writer KIT-19', status: 'ready', startedAt: at(1), endedAt: at(4), usage: { tokens: 1000, wallMs: 180_000 }, nonce: N0 }],
        pending: { kind: 'step', nonce: N1, output: join(dir, '.local', 'build-feature', 'step.json'), stage: { kind: 'step', step: 'planner' }, startedAt: at(5) },
      })
    })

    it.each([
      ['a malformed value', 'garbage'],
      ['a malformed run id', `run-x:${N1}`],
      ['a nonce that is not the pending one', `${RUN}:${OTHER}`],
    ])('refuses %s, naming --parent-run', async (_label, value) => {
      await expect(checkParentRun(dir, value, 'start')).rejects.toThrow(expect.objectContaining({ name: FlowRefused.name, message: expect.stringContaining('--parent-run') }))
    })

    it('accepts the pending step nonce at start', async () => {
      await expect(checkParentRun(dir, `${RUN}:${N1}`, 'start')).resolves.toEqual({ runId: RUN, nonce: N1 })
    })

    it('refuses an accepted step nonce at start', async () => {
      await expect(checkParentRun(dir, `${RUN}:${N0}`, 'start')).rejects.toBeInstanceOf(FlowRefused)
    })

    it('accepts an accepted step nonce of the run at finish', async () => {
      await expect(checkParentRun(dir, `${RUN}:${N0}`, 'finish')).resolves.toEqual({ runId: RUN, nonce: N0 })
    })
  })

  describe('the BOARD-003 attach gate (T10, F14)', () => {
    const CURRENT = '**BOARD-003 — MUST** put the spec and plan on the ticket as child pages named Spec and Plan, never as file attachments. One other write into the ticket page is allowed: every `/aspira-*` run on the ticket may append one run telemetry file block at the end of the page body, holding that run\'s telemetry file `<run-id>.json` (KIT-19).'
    const WITHOUT = '**BOARD-003 — MUST** put the spec and plan on the ticket as child pages named Spec and Plan, never as file attachments. The groomer also writes into the ticket page itself, and only there.'
    const SPLIT = `${WITHOUT}\n\nA later note: each run keeps its run telemetry file in the ticket folder.`

    it.each([
      ['the current BOARD-003 line', CURRENT, true],
      ['a BOARD-003 line without the telemetry file', WITHOUT, false],
      ['the phrase on a different line from BOARD-003', SPLIT, false],
    ])('reads %s as %s', (_label, rules, expected) => {
      expect(listsTelemetry(rules)).toBe(expected)
    })
  })

  describe('existing usage records stay untouched (T34, F17)', () => {
    it('leaves every usage file byte-identical with the same mtime after every reader runs', async () => {
      const files = [
        await writeJson(join(dir, 'groom', 'trace', 'usage.json'), groomerUsage),
        await writeJson(join(dir, '.static-analysis', 'usage.json'), ledgerUsage),
        await writeLines(join(dir, 'pr-review', 'usage.jsonl'), usageLines),
        await writeJson(join(dir, 'export', 'trace', 'session-usage.json'), { runId: RESOURCE.runId, subagents: [{ label: 'one', wallMs: 1000 }] }),
      ]
      for (const file of files) await touch(file, at(5))
      const snapshot = async () => Promise.all(files.map(async (file) => ({ bytes: (await readFile(file)).toString('base64'), mtime: (await stat(file)).mtimeMs })))
      const before = await snapshot()
      const [groomer, ledger, lines, session] = files as [string, string, string, string]
      await readUsageSource(groomer, { kind: 'usage.json', skill: 'groomer', start: T0, end: T10 })
      await readUsageSource(ledger, { kind: 'ledger', skill: 'code-analyzer', start: T0, end: T10 })
      await readUsageSource(lines, { kind: 'usage.jsonl', skill: 'pr-reviewer', models: PR_MODELS, start: T0, end: T10 })
      const read = await readSessionUsage(session)
      if ('usage' in read) subagentSpans(read.usage, { start: T0, end: T10 })
      expect(await snapshot()).toEqual(before)
    })
  })

  describe('no new dependency (T35, F18)', () => {
    /** Every third-party dependency the packages declare today, before KIT-19. */
    const PINNED = [
      '@ebay/nice-modal-react', '@eslint/js', '@hookform/resolvers', '@maskito/kit', '@modelcontextprotocol/sdk', '@radix-ui/react-avatar', '@radix-ui/react-checkbox',
      '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-portal', '@radix-ui/react-scroll-area', '@radix-ui/react-select', '@radix-ui/react-slider',
      '@radix-ui/react-slot', '@radix-ui/react-switch', '@radix-ui/react-tooltip', '@tanstack/react-query', '@tanstack/react-table', '@tanstack/react-virtual',
      '@testing-library/jest-dom', '@testing-library/react', '@testing-library/user-event', '@types/node', '@types/react', '@types/react-dom', '@vercel/connect', 'ai', 'amaro',
      'class-variance-authority', 'clsx', 'dayjs', 'eslint', 'eslint-config-next', 'eslint-plugin-unicorn', 'eve', 'framer-motion', 'globals', 'imask', 'input-otp', 'jsdom', 'react',
      'react-colorful', 'react-day-picker', 'react-dom', 'react-hook-form', 'react-imask', 'sonner', 'tailwind-merge', 'typescript', 'typescript-eslint', 'undici', 'vaul', 'vitest', 'zod',
    ]
    const manifestSchema = z.looseObject({ dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional() })

    async function dependencyNames(): Promise<string[]> {
      const root = fileURLToPath(new URL('../../../../../', import.meta.url))
      const folders = [
        ...(await readdir(join(root, 'packages'))).map((name) => join(root, 'packages', name)),
      ]
      const manifests = folders.map((folder) => join(folder, 'package.json')).filter((file) => existsSync(file))
      const names = await Promise.all(manifests.map(async (file) => {
        const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')))
        return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
      }))
      return [...new Set(names.flat())]
    }

    it('declares no opentelemetry package anywhere', async () => {
      expect((await dependencyNames()).filter((name) => name.includes('opentelemetry'))).toEqual([])
    })

    it('declares only the third-party dependencies pinned before KIT-19', async () => {
      expect((await dependencyNames()).filter((name) => !name.startsWith('@aspiralabs/') && !PINNED.includes(name))).toEqual([])
    })
  })
})
