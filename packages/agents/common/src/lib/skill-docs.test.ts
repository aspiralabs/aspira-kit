// T68, T69 (plan.json P12, F5, F13, F44, F51): every /aspira-* launcher's SKILL.md, after P30 lands,
// is user-invoked only (`disable-model-invocation: true`), no longer tells the reader to distrust its
// own exit code and read `trace/review.json` instead, says a non-zero exit is a run status to relay
// (never a reason to retry on needs-author, F5), and collapses its knowledge-fetching step to one
// line naming the shared `load-knowledge` command instead of a paragraph that walks the Notion MCP
// through building the folder by hand. None of this is true today: no SKILL.md frontmatter sets
// disable-model-invocation, several already say to read trace/review.json because the exit code lies
// (spec-reviewer and spec-writer SKILL.md: "Read trace/review.json for the status even when the
// command exits successfully"; planner SKILL.md:55: "eve process success alone is not plan approval"),
// none says a non-zero exit is a run status to relay, and every knowledge step is a multi-sentence
// paragraph that tells the session to fetch pages with the Notion MCP. This file fails until P30 lands.
//
// Every phrase and path here is copied from the plan's own P30 task description and the spec
// (spec.reviewed/spec.reviewed.md F13, F44, F51), never recomputed the way a SKILL.md would phrase it
// (TEST-006).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')

// The eight launcher skills (seven agents and build-feature), each `skill/aspira-<name>/SKILL.md`.
const LAUNCHER_SKILLS: { name: string; path: string }[] = [
  { name: 'groomer', path: 'packages/agents/groomer/skill/aspira-groomer/SKILL.md' },
  { name: 'spec-writer', path: 'packages/agents/spec-writer/skill/aspira-spec-writer/SKILL.md' },
  { name: 'spec-reviewer', path: 'packages/agents/spec-reviewer/skill/aspira-spec-reviewer/SKILL.md' },
  { name: 'planner', path: 'packages/agents/planner/skill/aspira-planner/SKILL.md' },
  { name: 'implementor', path: 'packages/agents/implementor/skill/aspira-implementor/SKILL.md' },
  { name: 'code-analyzer', path: 'packages/agents/code-analyzer/skill/aspira-code-analyzer/SKILL.md' },
  { name: 'pr-reviewer', path: 'packages/agents/pr-reviewer/skill/aspira-pr-reviewer/SKILL.md' },
  { name: 'build-feature', path: 'packages/agents/build-feature/skill/aspira-build-feature/SKILL.md' },
]
// The implementor cloud agent's own skill file, embedded by --local and load_skill'd in the cloud:
// not a launcher (no start/status/wait of its own), and never user-invoked directly.
const IMPLEMENTOR_CLOUD_SKILL = 'packages/agents/implementor/agent/skills/aspira-implementor/SKILL.md'
const ALL_SKILL_FILES = [...LAUNCHER_SKILLS.map((s) => s.path), IMPLEMENTOR_CLOUD_SKILL]

function readSkill(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  const frontmatter: Record<string, string> = {}
  if (!match) return frontmatter
  for (const line of match[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return frontmatter
}

describe('SKILL.md frontmatter: disable-model-invocation (T68, F44)', () => {
  it.each(LAUNCHER_SKILLS)('$name: the launcher skill declares disable-model-invocation: true', ({ path }) => {
    const frontmatter = parseFrontmatter(readSkill(path))
    expect(frontmatter['disable-model-invocation']).toBe('true')
  })

  it("the implementor cloud agent's own agent/skills SKILL.md does not declare disable-model-invocation", () => {
    const frontmatter = parseFrontmatter(readSkill(IMPLEMENTOR_CLOUD_SKILL))
    expect(frontmatter['disable-model-invocation']).toBeUndefined()
  })
})

// The exact "the exit code lies, read the trace yourself" phrases F13 removes: the two already in
// spec-reviewer/spec-writer, planner's own wording, and the Intent's own two sentences
// (spec.reviewed.md: `packages/kit/src/playbook.ts:54,64,79` repeats "for the real status ... can
// exit 0 on a failed run"), in case a later SKILL.md edit reintroduces that exact Playbook phrasing.
const EXIT_CODE_DISTRUST_PHRASES = [
  'even when the command exits successfully',
  'success alone is not',
  'for the real status',
  'can exit 0 on a failed run',
  'exits 0 on a failed run',
]

describe('SKILL.md bodies no longer distrust the exit code (T69, F13)', () => {
  it.each(ALL_SKILL_FILES)('%s has none of the "read the trace, the exit code lies" phrases', (path) => {
    const body = readSkill(path).toLowerCase()
    for (const phrase of EXIT_CODE_DISTRUST_PHRASES) expect(body).not.toContain(phrase)
  })
})

describe('Launcher SKILL.md says a non-zero exit is a run status to relay, never retried on needs-author (T69, F5)', () => {
  it.each(LAUNCHER_SKILLS)('$name', ({ path }) => {
    const body = readSkill(path)
    expect(body).toMatch(/non-zero exit is a run status to relay/i)
    expect(body).toMatch(/never (?:retry|rerun)[^.]*needs-author|needs-author[^.]*never (?:retry|rerun)/i)
  })
})

// Decision Q4 (REBA2.1): needs-author exits with its own code, 5, distinct from a failure (1:
// incomplete, blocked) and a refusal (3). Every launcher SKILL.md and every agent README that names
// the exit codes names them this way, never needs-author as exit 1 (copied from Q4, TEST-006).
const EXIT_CODE_LINE = /exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author/
const AGENT_READMES = ['planner', 'spec-reviewer', 'spec-writer', 'code-analyzer'].map((name) => `packages/agents/${name}/README.md`)

describe('Launcher SKILL.md and agent READMEs name needs-author\'s own exit code, 5 (REBA2.1, Decision Q4)', () => {
  it.each(LAUNCHER_SKILLS)('$name SKILL.md lists the run-status exit codes', ({ path }) => {
    expect(readSkill(path)).toMatch(EXIT_CODE_LINE)
  })

  it.each(AGENT_READMES)('%s lists the run-status exit codes and never calls needs-author exit 1', (path) => {
    const body = readSkill(path)
    expect(body).toMatch(EXIT_CODE_LINE)
    expect(body).not.toMatch(/exit 1 means[^.]*needs-author|1 means needs-author/i)
  })
})

type KnowledgeStep = { name: string; path: string; anchor: RegExp }

// Each launcher's knowledge-fetching step starts with its own distinct heading line (column 0, a
// top-level numbered step); build-feature has none of its own (it steps each stage's own skill).
const KNOWLEDGE_STEPS: KnowledgeStep[] = [
  { name: 'groomer', path: 'packages/agents/groomer/skill/aspira-groomer/SKILL.md', anchor: /^\d+\.\s\*\*Knowledge\.\*\*/ },
  { name: 'spec-writer', path: 'packages/agents/spec-writer/skill/aspira-spec-writer/SKILL.md', anchor: /^\d+\.\s\*\*Knowledge\.\*\*/ },
  { name: 'spec-reviewer', path: 'packages/agents/spec-reviewer/skill/aspira-spec-reviewer/SKILL.md', anchor: /^\d+\.\s\*\*Knowledge\.\*\*/ },
  { name: 'planner', path: 'packages/agents/planner/skill/aspira-planner/SKILL.md', anchor: /^\d+\.\sStage `knowledge`:/ },
  { name: 'implementor', path: 'packages/agents/implementor/skill/aspira-implementor/SKILL.md', anchor: /^\d+\.\s\*\*`knowledge`\*\*/ },
  { name: 'code-analyzer', path: 'packages/agents/code-analyzer/skill/aspira-code-analyzer/SKILL.md', anchor: /^\d+\.\s\*\*Knowledge\.\*\*/ },
  { name: 'pr-reviewer', path: 'packages/agents/pr-reviewer/skill/aspira-pr-reviewer/SKILL.md', anchor: /^\d+\.\s\*\*Guidelines\.\*\*/ },
]

/** The knowledge step's own text: from its heading line up to (not including) the next top-level
 * numbered step (a line starting, with no indentation, digits-dot-space), or the end of the file. */
function extractStep(body: string, anchor: RegExp): string {
  const lines = body.split('\n')
  const stepStart = /^\d+\.\s/
  const start = lines.findIndex((line) => anchor.test(line))
  if (start === -1) throw new Error(`no line matches ${anchor.source} in this SKILL.md`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (stepStart.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

describe('Each launcher SKILL.md knowledge step is one line naming load-knowledge (T69, F51)', () => {
  it.each(KNOWLEDGE_STEPS)('$name', ({ path, anchor }) => {
    const step = extractStep(readSkill(path), anchor)
    expect(step.length).toBeLessThan(250)
    expect(step).toContain('load-knowledge')
    expect(step.toLowerCase()).not.toContain('notion mcp')
  })
})
