import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { doctor } from './doctor.js'
import { AGENTS, agentPackageDir, checkSkills, installSkills, skillDir, VERSION_FILE } from './skills.js'

type Layout = 'npm' | 'pnpm'

/** The kit-owned skills every project gets from @aspiralabs/kit itself, beside the seven agent skills. */
const KIT_OWNED = ['cleanup', 'next', 'worktree'] as const
/** The version in packages/kit/package.json: the kit-owned skills are stamped with it. */
const KIT_VERSION = (JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')) as { version: string }).version

const kitSkill = (root: string, name: string): string => join(root, '.claude', 'skills', `aspira-${name}`)

/** The log lines installSkills prints for the seven agent skills only, by verb. */
const agentLines = (lines: string[], verb: string): string[] => lines.filter((l) => l.startsWith(verb) && AGENTS.some((agent) => l.includes(`.claude/skills/aspira-${agent} (`)))

/** A package.json at `dir` naming the package. */
function manifest(dir: string, name: string, version = '0.5.0'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}

/** A project with @aspiralabs/agents and every agent installed, laid out as npm (hoisted) or pnpm (beside the meta-package) would. */
function project(version: string, layout: Layout = 'npm'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-skills-')))
  const scope = layout === 'npm' ? join(root, 'node_modules', '@aspiralabs') : join(root, 'node_modules', '.pnpm', `@aspiralabs+agents@${version}`, 'node_modules', '@aspiralabs')
  const pkg = (name: string, dir: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version, ...extra }))
    return dir
  }
  pkg('agents', join(scope, 'agents'))
  if (layout === 'pnpm') {
    mkdirSync(join(root, 'node_modules', '@aspiralabs'), { recursive: true })
    symlinkSync(join(scope, 'agents'), join(root, 'node_modules', '@aspiralabs', 'agents'))
  }
  for (const agent of AGENTS) {
    const dir = pkg(agent, join(scope, agent))
    mkdirSync(join(dir, 'skill', `aspira-${agent}`, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'skill', `aspira-${agent}`, 'SKILL.md'), `---\nname: aspira-${agent}\n---\n# ${agent} ${version}\n`)
    writeFileSync(join(dir, 'skill', `aspira-${agent}`, 'scripts', `${agent}.sh`), '#!/bin/bash\necho hi\n')
    chmodSync(join(dir, 'skill', `aspira-${agent}`, 'scripts', `${agent}.sh`), 0o644)
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@aspiralabs/agents': version } }))
  return root
}

/**
 * This repository's own layout: node_modules/@aspiralabs/agents is a workspace link to packages/agents/meta,
 * and agent-common sits in the sibling folder `common` (not `agent-common`). `metaLink` adds meta's own
 * node_modules/@aspiralabs/agent-common link, where pnpm puts meta's workspace dependency. `agents` adds the
 * seven agent packages under packages/agents/<agent>, each with its skill folder.
 */
function selfHosting(opts: { common: boolean; metaLink: boolean; agents?: boolean }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-self-')))
  const agentsDir = join(root, 'packages', 'agents')
  const meta = manifest(join(agentsDir, 'meta'), '@aspiralabs/agents', '0.6.1')
  if (opts.common) manifest(join(agentsDir, 'common'), '@aspiralabs/agent-common', '0.6.1')
  if (opts.metaLink) {
    mkdirSync(join(meta, 'node_modules', '@aspiralabs'), { recursive: true })
    symlinkSync(join('..', '..', '..', 'common'), join(meta, 'node_modules', '@aspiralabs', 'agent-common'))
  }
  if (opts.agents === true) {
    for (const agent of AGENTS) {
      const dir = manifest(join(agentsDir, agent), `@aspiralabs/${agent}`, '0.6.1')
      mkdirSync(join(dir, 'skill', `aspira-${agent}`, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'skill', `aspira-${agent}`, 'SKILL.md'), `---\nname: aspira-${agent}\n---\n# ${agent} self-hosted\n`)
      writeFileSync(join(dir, 'skill', `aspira-${agent}`, 'scripts', `${agent}.sh`), '#!/bin/bash\necho hi\n')
      chmodSync(join(dir, 'skill', `aspira-${agent}`, 'scripts', `${agent}.sh`), 0o644)
    }
  }
  mkdirSync(join(root, 'node_modules', '@aspiralabs'), { recursive: true })
  symlinkSync(join('..', '..', 'packages', 'agents', 'meta'), join(root, 'node_modules', '@aspiralabs', 'agents'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'aspira-kit', private: true }))
  return root
}

const logs = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

describe('agentPackageDir', () => {
  it('finds an agent hoisted into the project, or beside @aspiralabs/agents under pnpm', () => {
    const npm = project('0.5.0', 'npm')
    expect(agentPackageDir(npm, 'planner')).toBe(join(npm, 'node_modules', '@aspiralabs', 'planner'))
    const pnpm = project('0.5.0', 'pnpm')
    expect(agentPackageDir(pnpm, 'planner')).toBe(join(pnpm, 'node_modules', '.pnpm', '@aspiralabs+agents@0.5.0', 'node_modules', '@aspiralabs', 'planner'))
    expect(agentPackageDir(realpathSync(mkdtempSync(join(tmpdir(), 'kit-empty-'))), 'planner')).toBeUndefined()
  })

  // TEST-009 regression: in this checkout `kit next` found no agent-common, because the lookup took the
  // sibling folder named after the package (`agent-common`) and the folder is `common`.
  it('finds agent-common in the self-hosting layout through meta\'s own node_modules link', () => {
    const root = selfHosting({ common: true, metaLink: true })
    const found = agentPackageDir(root, 'agent-common')
    expect(found === undefined ? undefined : realpathSync(found)).toBe(realpathSync(join(root, 'packages', 'agents', 'common')))
  })

  it('returns undefined in the self-hosting layout when no agent-common folder exists', () => {
    expect(agentPackageDir(selfHosting({ common: false, metaLink: false }), 'agent-common')).toBeUndefined()
  })

  it('finds a sibling package by its package.json name, not its folder name', () => {
    const root = selfHosting({ common: true, metaLink: false })
    manifest(join(root, 'packages', 'agents', 'agent-common-old'), '@aspiralabs/agent-common-legacy')
    expect(agentPackageDir(root, 'agent-common')).toBe(join(root, 'packages', 'agents', 'common'))
  })
})

describe('installSkills', () => {
  it('writes the seven skill folders as copies of the installed packages, each with .kit-version, and keeps them on a re-run', () => {
    const root = project('0.5.0', 'pnpm')
    const first = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log: first.log })).toEqual([])
    for (const agent of AGENTS) {
      const dir = skillDir(root, agent)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain(`# ${agent} 0.5.0`)
      expect(readFileSync(join(dir, VERSION_FILE), 'utf8')).toBe('0.5.0\n')
      // The launcher is executable even when the package manager dropped the bit.
      expect(statSync(join(dir, 'scripts', `${agent}.sh`)).mode & 0o111).not.toBe(0)
    }
    expect(agentLines(first.lines, 'write ').length).toBe(7)
    for (const name of KIT_OWNED) {
      expect(first.lines.some((l) => l.startsWith('write ') && l.includes(`.claude/skills/aspira-${name}`)), name).toBe(true)
    }
    const again = logs()
    installSkills({ projectRoot: root, dryRun: false, log: again.log })
    expect(again.lines.every((l) => l.startsWith('keep   '))).toBe(true)
  })

  it('rewrites a skill after a bump, drops stale files, and changes nothing in a dry run', () => {
    const root = project('0.5.0')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    writeFileSync(join(skillDir(root, 'planner'), 'stale.md'), 'old')
    // The project bumps @aspiralabs/agents: the installed packages change, the committed copies lag.
    rmSync(join(root, 'node_modules'), { recursive: true })
    const bumped = project('0.6.0')
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    symlinkSync(join(bumped, 'node_modules'), join(root, 'node_modules'))
    const dry = logs()
    installSkills({ projectRoot: root, dryRun: true, log: dry.log })
    expect(agentLines(dry.lines, 'update ').length).toBe(7)
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe('0.5.0\n')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe('0.6.0\n')
    expect(readFileSync(join(skillDir(root, 'planner'), 'SKILL.md'), 'utf8')).toContain('0.6.0')
    expect(existsSync(join(skillDir(root, 'planner'), 'stale.md'))).toBe(false)
  })

  it('skips the agent skills with a note when @aspiralabs/agents is not installed, and still writes the kit-owned skills at the kit version', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-noagents-')))
    const { lines, log } = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log })).toEqual([...AGENTS])
    expect(lines.some((l) => l.startsWith('skip ') && l.includes('@aspiralabs/agents is not installed'))).toBe(true)
    for (const agent of AGENTS) expect(existsSync(skillDir(root, agent)), agent).toBe(false)
    for (const name of KIT_OWNED) {
      expect(readFileSync(join(kitSkill(root, name), VERSION_FILE), 'utf8'), name).toBe(`${KIT_VERSION}\n`)
    }
  })

  it('writes the seven agent skills and the three kit-owned skills in the npm layout and in this repository\'s self-hosting layout', () => {
    const cases: Array<[string, string, string]> = [
      ['npm', project('0.5.0'), '0.5.0'],
      ['self-hosting', selfHosting({ common: true, metaLink: true, agents: true }), '0.6.1'],
    ]
    for (const [layout, root, version] of cases) {
      installSkills({ projectRoot: root, dryRun: false, log: () => {} })
      for (const agent of AGENTS) {
        expect(existsSync(join(skillDir(root, agent), 'SKILL.md')), `${layout} ${agent}`).toBe(true)
        expect(readFileSync(join(skillDir(root, agent), VERSION_FILE), 'utf8'), `${layout} ${agent}`).toBe(`${version}\n`)
      }
      for (const name of KIT_OWNED) {
        expect(existsSync(join(kitSkill(root, name), 'SKILL.md')), `${layout} ${name}`).toBe(true)
        expect(statSync(join(kitSkill(root, name), 'scripts', `${name}.sh`)).mode & 0o111, `${layout} ${name}`).not.toBe(0)
      }
    }
  })
})

describe('checkSkills and kit doctor', () => {
  /** Everything else doctor checks, so only the skills decide the verdict. */
  function wire(root: string) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    // @aspiralabs/kit is installed at this kit's own version, the one the kit-owned skills are stamped with.
    pkg.devDependencies = { ...pkg.devDependencies, '@aspiralabs/config': '0.5.0', '@aspiralabs/kit': KIT_VERSION, '@aspiralabs/ui': '0.5.0' }
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    for (const [name, version] of [['ui', '0.5.0'], ['config', '0.5.0'], ['kit', KIT_VERSION]] as const) {
      mkdirSync(join(root, 'node_modules', '@aspiralabs', name), { recursive: true })
      writeFileSync(join(root, 'node_modules', '@aspiralabs', name, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version }))
    }
    writeFileSync(join(root, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\nexport default next\n")
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: '@aspiralabs/config/tsconfig/next.json' }))
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'app', 'globals.css'), '@import "@aspiralabs/ui/tokens.css";\n')
    writeFileSync(join(root, 'AGENTS.md'), '<!-- aspiralabs:begin -->\n<!-- aspiralabs:end -->\n')
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': {} } }))
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'sh node_modules/@aspiralabs/kit/hooks/session-start.sh' }] }] } }))
    // The ignore lines doctor checks; the temp dir is not a git repository, so the git-based checks report skipped.
    writeFileSync(join(root, '.gitignore'), '.work/\n.aspira/\n.worktrees/\n.env.local\n')
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6' }))
  }

  it('fails on a missing folder and on a version mismatch, and passes after re-init', () => {
    const root = project('0.5.0')
    wire(root)
    const before = logs()
    expect(doctor(root, before.log)).toBe(1)
    expect(before.lines).toContain('FAIL .claude/skills/aspira-planner is missing')
    expect(before.lines.some((l) => l.startsWith('@aspiralabs/agents') && l.includes('installed 0.5.0'))).toBe(true)

    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    const healthy = logs()
    expect(doctor(root, healthy.log)).toBe(0)
    expect(healthy.lines.filter((l) => l.startsWith('ok   .claude/skills/aspira-') && l.endsWith(' matches @aspiralabs/agents')).length).toBe(7)
    expect(healthy.lines.filter((l) => l.startsWith('ok   .claude/skills/aspira-') && l.endsWith(' matches @aspiralabs/kit')).length).toBe(3)
    expect(checkSkills(root).every((c) => c.ok)).toBe(true)

    writeFileSync(join(skillDir(root, 'pr-reviewer'), VERSION_FILE), '0.4.0\n')
    const stale = checkSkills(root)
    expect(stale.find((c) => c.reason?.includes('aspira-pr-reviewer'))?.reason).toBe('.claude/skills/aspira-pr-reviewer is from 0.4.0, @aspiralabs/agents is 0.5.0')
    const mismatch = logs()
    expect(doctor(root, mismatch.log)).toBe(1)
    expect(mismatch.lines).toContain('FAIL .claude/skills/aspira-pr-reviewer is from 0.4.0, @aspiralabs/agents is 0.5.0')

    rmSync(skillDir(root, 'implementor'), { recursive: true })
    expect(checkSkills(root).find((c) => c.reason?.includes('aspira-implementor'))?.reason).toBe('.claude/skills/aspira-implementor is missing')

    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(doctor(root, () => {})).toBe(0)
  })

  it('installs .claude/skills/aspira-groomer with the others and reports it missing or stale like them', () => {
    const root = project('0.5.0')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    const groomer = join(root, '.claude', 'skills', 'aspira-groomer')
    expect(readFileSync(join(groomer, VERSION_FILE), 'utf8')).toBe('0.5.0\n')
    rmSync(groomer, { recursive: true })
    const missing = checkSkills(root).find((c) => c.reason?.includes('aspira-groomer'))
    expect(missing?.reason).toBe('.claude/skills/aspira-groomer is missing')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    writeFileSync(join(groomer, VERSION_FILE), '0.4.0\n')
    const stale = checkSkills(root).find((c) => c.reason?.includes('aspira-groomer'))
    expect(stale?.reason).toBe('.claude/skills/aspira-groomer is from 0.4.0, @aspiralabs/agents is 0.5.0')
  })

  it('reports a skill it cannot check when @aspiralabs/agents is missing', () => {
    const root = project('0.5.0')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(checkSkills(root).some((c) => c.reason?.includes('@aspiralabs/agents is not installed'))).toBe(true)
  })

  describe('the kit-owned skills', () => {
    /** A wired project with every skill installed: healthy until a case breaks one kit-owned skill. */
    function healthyProject(): string {
      const root = project('0.5.0')
      wire(root)
      installSkills({ projectRoot: root, dryRun: false, log: () => {} })
      return root
    }

    it('doctor prints the seven agent skill lines unchanged and three kit-owned lines matching @aspiralabs/kit', () => {
      const { lines, log } = logs()
      expect(doctor(healthyProject(), log)).toBe(0)
      const skillLines = lines.filter((l) => l.includes('.claude/skills/aspira-'))
      expect(skillLines.length).toBe(10)
      for (const agent of AGENTS) expect(lines).toContain(`ok   .claude/skills/aspira-${agent} matches @aspiralabs/agents`)
      for (const name of KIT_OWNED) {
        expect(skillLines.some((l) => l.startsWith('ok   ') && l.includes(`.claude/skills/aspira-${name} `) && l.endsWith('matches @aspiralabs/kit')), name).toBe(true)
      }
    })

    it('doctor fails on a missing kit-owned skill folder', () => {
      const root = healthyProject()
      rmSync(kitSkill(root, 'next'), { recursive: true })
      const { lines, log } = logs()
      expect(doctor(root, log)).toBe(1)
      expect(lines.some((l) => l.startsWith('FAIL') && l.includes('.claude/skills/aspira-next') && l.includes('missing'))).toBe(true)
    })

    it('doctor fails on a kit-owned skill without its launcher script', () => {
      const root = healthyProject()
      rmSync(join(kitSkill(root, 'cleanup'), 'scripts', 'cleanup.sh'))
      const { lines, log } = logs()
      expect(doctor(root, log)).toBe(1)
      expect(lines.some((l) => l.startsWith('FAIL') && l.includes('.claude/skills/aspira-cleanup/scripts/cleanup.sh') && l.includes('missing'))).toBe(true)
    })

    it('doctor fails on a kit-owned skill from another kit version, against the @aspiralabs/kit version', () => {
      const root = healthyProject()
      writeFileSync(join(kitSkill(root, 'worktree'), VERSION_FILE), '0.0.1\n')
      const { lines, log } = logs()
      expect(doctor(root, log)).toBe(1)
      expect(lines.some((l) => l.startsWith('FAIL') && l.includes('.claude/skills/aspira-worktree') && l.includes('is from 0.0.1') && l.includes('@aspiralabs/kit'))).toBe(true)
    })
  })
})
