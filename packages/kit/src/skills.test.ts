import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctor } from './doctor.js'
import { AGENTS, agentPackageDir, checkSkills, installSkills, skillDir, VERSION_FILE } from './skills.js'

type Layout = 'npm' | 'pnpm'

/** A project with @aspiralabs/agents and the six agents installed, laid out as npm (hoisted) or pnpm (beside the meta-package) would. */
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
})

describe('installSkills', () => {
  it('writes the six skill folders as copies of the installed packages, each with .kit-version, and keeps them on a re-run', () => {
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
    expect(first.lines.filter((l) => l.startsWith('write ')).length).toBe(6)
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
    expect(dry.lines.filter((l) => l.startsWith('update ')).length).toBe(6)
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe('0.5.0\n')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe('0.6.0\n')
    expect(readFileSync(join(skillDir(root, 'planner'), 'SKILL.md'), 'utf8')).toContain('0.6.0')
    expect(existsSync(join(skillDir(root, 'planner'), 'stale.md'))).toBe(false)
  })

  it('skips with a note when @aspiralabs/agents is not installed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-noagents-')))
    const { lines, log } = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log })).toEqual([...AGENTS])
    expect(lines[0]).toContain('@aspiralabs/agents is not installed')
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })
})

describe('checkSkills and kit doctor', () => {
  /** Everything else doctor checks, so only the skills decide the verdict. */
  function wire(root: string) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    pkg.devDependencies = { ...pkg.devDependencies, '@aspiralabs/config': '0.5.0', '@aspiralabs/kit': '0.5.0', '@aspiralabs/ui': '0.5.0' }
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    for (const name of ['ui', 'config', 'kit']) {
      mkdirSync(join(root, 'node_modules', '@aspiralabs', name), { recursive: true })
      writeFileSync(join(root, 'node_modules', '@aspiralabs', name, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version: '0.5.0' }))
    }
    writeFileSync(join(root, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\nexport default next\n")
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: '@aspiralabs/config/tsconfig/next.json' }))
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'app', 'globals.css'), '@import "@aspiralabs/ui/tokens.css";\n')
    writeFileSync(join(root, 'AGENTS.md'), '<!-- aspiralabs:begin -->\n<!-- aspiralabs:end -->\n')
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': {} } }))
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'session-start.sh' }] }] } }))
    writeFileSync(join(root, '.gitignore'), '.work/\n')
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
    expect(healthy.lines.filter((l) => l.startsWith('ok   .claude/skills/aspira-')).length).toBe(6)
    expect(checkSkills(root).every((c) => c.ok)).toBe(true)

    writeFileSync(join(skillDir(root, 'pr-reviewer'), VERSION_FILE), '0.4.0\n')
    const stale = checkSkills(root)
    expect(stale.find((c) => c.agent === 'pr-reviewer')).toEqual({ agent: 'pr-reviewer', ok: false, reason: '.claude/skills/aspira-pr-reviewer is from 0.4.0, @aspiralabs/agents is 0.5.0' })
    const mismatch = logs()
    expect(doctor(root, mismatch.log)).toBe(1)
    expect(mismatch.lines).toContain('FAIL .claude/skills/aspira-pr-reviewer is from 0.4.0, @aspiralabs/agents is 0.5.0')

    rmSync(skillDir(root, 'implementor'), { recursive: true })
    expect(checkSkills(root).find((c) => c.agent === 'implementor')?.reason).toBe('.claude/skills/aspira-implementor is missing')

    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(doctor(root, () => {})).toBe(0)
  })

  it('reports a skill it cannot check when @aspiralabs/agents is missing', () => {
    const root = project('0.5.0')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(checkSkills(root)[0]?.reason).toContain('@aspiralabs/agents is not installed')
  })
})
