import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { doctor } from './doctor.js'
import { AGENTS, AI_PACKAGE, aiPackageDir, checkSkills, HOOKS, HOOKS_DIR, installHooks, installSkills, kitPackageDir, skillDir, VERSION_FILE } from './skills.js'

/** The kit-owned skills, beside the eight agent skills; all eleven ship in @aspiralabs/ai. */
const KIT_OWNED = ['cleanup', 'next', 'worktree'] as const
/** The running package's own version (the global install's, in a project): every skill is stamped with it when the app has no @aspiralabs/ai of its own. */
const KIT_VERSION = (JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')) as { version: string }).version

const kitSkill = (root: string, name: string): string => join(root, '.claude', 'skills', `aspira-${name}`)
/** `.claude/skills/aspira-build-feature`. */
const buildFeatureSkillDir = (root: string) => kitSkill(root, 'build-feature')

/** The log lines installSkills prints for the eight agent skills only, by verb. */
const agentLines = (lines: string[], verb: string): string[] => lines.filter((l) => l.startsWith(verb) && AGENTS.some((agent) => l.includes(`.claude/skills/aspira-${agent} (`)))

/** The version of the app's @aspiralabs/ai install in the fixtures: the one version all eleven skills carry. */
const AI_VERSION = '0.16.0'
/** A line only the app's install carries, so a test can tell its files from the running package's own. */
const MARKER = 'from-app-install'

/** A package.json at `dir` naming the package. */
function manifest(dir: string, name: string, version = '0.5.0'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}

/** @aspiralabs/ai laid out at `dir`: the three kit skills under skills/ and the eight agents' skills under <agent>/skill/. */
function aiPackage(dir: string, version: string, text = MARKER): string {
  manifest(dir, AI_PACKAGE, version)
  const skill = (folder: string, name: string, body: string) => {
    mkdirSync(join(folder, 'scripts'), { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: aspira-${name}\n---\n# ${name} ${version}\n${body}\n`)
    writeFileSync(join(folder, 'scripts', `${name}.sh`), '#!/bin/bash\necho hi\n')
    chmodSync(join(folder, 'scripts', `${name}.sh`), 0o644)
  }
  for (const name of KIT_OWNED) skill(join(dir, 'skills', `aspira-${name}`), name, text)
  for (const agent of AGENTS) skill(join(dir, agent, 'skill', `aspira-${agent}`), agent, text)
  return dir
}

/** An app whose node_modules/@aspiralabs/ai is a plain install at `version`. */
function project(version: string = AI_VERSION): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-skills-')))
  aiPackage(join(root, 'node_modules', '@aspiralabs', 'ai'), version)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { [AI_PACKAGE]: version } }))
  return root
}

/** An app on the 0.15 layout: @aspiralabs/kit and @aspiralabs/agents installed, no @aspiralabs/ai. */
function legacyProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-legacy-')))
  manifest(join(root, 'node_modules', '@aspiralabs', 'kit'), '@aspiralabs/kit', '0.15.0')
  manifest(join(root, 'node_modules', '@aspiralabs', 'agents'), '@aspiralabs/agents', '0.15.0')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@aspiralabs/kit': '0.15.0', '@aspiralabs/agents': '0.15.0' } }))
  return root
}

/** This repository's own layout: packages/ai holds the package and node_modules/@aspiralabs/ai is a workspace link to it. */
function selfHosting(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-self-')))
  aiPackage(join(root, 'packages', 'ai'), '0.6.1', 'self-hosted')
  mkdirSync(join(root, 'node_modules', '@aspiralabs'), { recursive: true })
  symlinkSync(join('..', '..', 'packages', 'ai'), join(root, 'node_modules', '@aspiralabs', 'ai'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'aspira-kit', private: true }))
  return root
}

const logs = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

describe('aiPackageDir', () => {
  it('finds a copy an earlier kit installed in the app, else the running package: the global install', () => {
    const root = project()
    expect(aiPackageDir(root)).toBe(join(root, 'node_modules', '@aspiralabs', 'ai'))
    expect(aiPackageDir(realpathSync(mkdtempSync(join(tmpdir(), 'kit-empty-'))))).toBe(kitPackageDir())
    // The 0.15 packages are never looked up.
    expect(aiPackageDir(legacyProject())).toBe(kitPackageDir())
  })

  it('finds the workspace link in the self-hosting layout', () => {
    const root = selfHosting()
    const found = aiPackageDir(root)
    expect(found === undefined ? undefined : realpathSync(found)).toBe(realpathSync(join(root, 'packages', 'ai')))
  })

  it('ignores a folder at the right path whose package.json names another package', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-wrong-')))
    manifest(join(root, 'node_modules', '@aspiralabs', 'ai'), '@aspiralabs/other')
    expect(aiPackageDir(root)).toBe(kitPackageDir())
  })
})

describe('installSkills', () => {
  it('writes all eleven skill folders as copies of the app\'s @aspiralabs/ai install, each with its version, and keeps them on a re-run', () => {
    const root = project()
    const first = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log: first.log })).toEqual([])
    for (const agent of AGENTS) {
      const dir = skillDir(root, agent)
      const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      expect(text).toContain(`# ${agent} ${AI_VERSION}`)
      expect(text).toContain(MARKER)
      expect(readFileSync(join(dir, VERSION_FILE), 'utf8')).toBe(`${AI_VERSION}\n`)
      // The launcher is executable even when the package manager dropped the bit.
      expect(statSync(join(dir, 'scripts', `${agent}.sh`)).mode & 0o111).not.toBe(0)
    }
    // The kit-owned skills come from the app's install too, not from the running package.
    for (const name of KIT_OWNED) {
      expect(readFileSync(join(kitSkill(root, name), 'SKILL.md'), 'utf8'), name).toContain(MARKER)
      expect(readFileSync(join(kitSkill(root, name), VERSION_FILE), 'utf8'), name).toBe(`${AI_VERSION}\n`)
      expect(statSync(join(kitSkill(root, name), 'scripts', `${name}.sh`)).mode & 0o111, name).not.toBe(0)
    }
    expect(agentLines(first.lines, 'write ').length).toBe(8)
    expect(readdirSync(join(root, '.claude', 'skills')).filter((entry) => entry.startsWith('aspira-')).length).toBe(11)
    // build-feature and visual-verify install like the other agents.
    expect(readFileSync(join(buildFeatureSkillDir(root), 'SKILL.md'), 'utf8')).toContain(`# build-feature ${AI_VERSION}`)
    const visualVerify = join(root, '.claude', 'skills', 'aspira-visual-verify')
    expect(existsSync(join(visualVerify, 'scripts', 'visual-verify.sh'))).toBe(true)
    expect(readFileSync(join(visualVerify, VERSION_FILE), 'utf8')).toBe(`${AI_VERSION}\n`)
    const again = logs()
    installSkills({ projectRoot: root, dryRun: false, log: again.log })
    expect(again.lines.every((l) => l.startsWith('keep   '))).toBe(true)
  })

  it('checkSkills reports aspira-build-feature missing its launcher when scripts/build-feature.sh is removed', () => {
    const root = project()
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    rmSync(join(buildFeatureSkillDir(root), 'scripts', 'build-feature.sh'))
    const missing = checkSkills(root).find((c) => c.reason?.includes('aspira-build-feature'))
    expect(missing?.reason).toBe('.claude/skills/aspira-build-feature/scripts/build-feature.sh is missing')
  })

  it('rewrites every skill after a bump, drops stale files, and changes nothing in a dry run', () => {
    const root = project('0.15.0')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    writeFileSync(join(skillDir(root, 'planner'), 'stale.md'), 'old')
    // The project bumps @aspiralabs/ai: the installed package changes, the committed copies lag.
    rmSync(join(root, 'node_modules'), { recursive: true })
    aiPackage(join(root, 'node_modules', '@aspiralabs', 'ai'), AI_VERSION)
    const dry = logs()
    installSkills({ projectRoot: root, dryRun: true, log: dry.log })
    expect(dry.lines.filter((l) => l.startsWith('update ')).length).toBe(11)
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe('0.15.0\n')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(readFileSync(join(skillDir(root, 'planner'), VERSION_FILE), 'utf8')).toBe(`${AI_VERSION}\n`)
    expect(readFileSync(join(skillDir(root, 'planner'), 'SKILL.md'), 'utf8')).toContain(AI_VERSION)
    expect(existsSync(join(skillDir(root, 'planner'), 'stale.md'))).toBe(false)
  })

  it('with no @aspiralabs/ai in the project, writes all eleven skills from the running package (the global install) at its version', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-noai-')))
    const { lines, log } = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log })).toEqual([])
    expect(lines.some((l) => l.includes('@aspiralabs/agents') || l.includes('@aspiralabs/kit'))).toBe(false)
    for (const name of [...AGENTS, ...KIT_OWNED]) {
      expect(readFileSync(join(kitSkill(root, name), VERSION_FILE), 'utf8'), name).toBe(`${KIT_VERSION}\n`)
      expect(readFileSync(join(kitSkill(root, name), 'SKILL.md'), 'utf8'), name).not.toContain(MARKER)
    }
    expect(checkSkills(root).every((c) => c.ok)).toBe(true)
  })

  it('treats the 0.15 layout (kit and agents installed, no ai) like no install: every skill from the running package, nothing names @aspiralabs/agents', () => {
    const root = legacyProject()
    const { lines, log } = logs()
    expect(installSkills({ projectRoot: root, dryRun: false, log })).toEqual([])
    expect(lines.some((l) => l.includes('@aspiralabs/agents'))).toBe(false)
    for (const check of checkSkills(root)) expect(check.package).toBe('@aspiralabs/ai')
    expect(checkSkills(root).every((c) => c.ok)).toBe(true)
  })

  it('installHooks copies the three hooks into .claude/hooks/aspira/, executable, and keeps them on a re-run', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-hooks-')))
    installHooks({ projectRoot: root, dryRun: false, log: () => {} })
    for (const name of HOOKS) {
      const target = join(root, HOOKS_DIR, name)
      expect(readFileSync(target, 'utf8'), name).toBe(readFileSync(join(kitPackageDir(), 'hooks', name), 'utf8'))
      expect(statSync(target).mode & 0o111, name).not.toBe(0)
    }
    const again = logs()
    installHooks({ projectRoot: root, dryRun: false, log: again.log })
    expect(again.lines).toEqual(HOOKS.map((name) => `keep   ${HOOKS_DIR}/${name}`))
  })

  it('writes all eleven skills from a plain install and from this repository\'s workspace link', () => {
    const cases: Array<[string, string, string]> = [
      ['installed', project(), AI_VERSION],
      ['self-hosting', selfHosting(), '0.6.1'],
    ]
    for (const [layout, root, version] of cases) {
      installSkills({ projectRoot: root, dryRun: false, log: () => {} })
      for (const agent of AGENTS) {
        expect(existsSync(join(skillDir(root, agent), 'SKILL.md')), `${layout} ${agent}`).toBe(true)
        expect(readFileSync(join(skillDir(root, agent), VERSION_FILE), 'utf8'), `${layout} ${agent}`).toBe(`${version}\n`)
      }
      for (const name of KIT_OWNED) {
        expect(existsSync(join(kitSkill(root, name), 'SKILL.md')), `${layout} ${name}`).toBe(true)
        expect(readFileSync(join(kitSkill(root, name), VERSION_FILE), 'utf8'), `${layout} ${name}`).toBe(`${version}\n`)
        expect(statSync(join(kitSkill(root, name), 'scripts', `${name}.sh`)).mode & 0o111, `${layout} ${name}`).not.toBe(0)
      }
    }
  })
})

describe('checkSkills and kit doctor', () => {
  /** A project on the global install: no @aspiralabs/ai of its own, so the running package is the one checked against. */
  function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-global-')))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
    return root
  }
  /** Everything else doctor checks, so only the skills decide the verdict. */
  function wire(root: string) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }
    pkg.devDependencies = { ...pkg.devDependencies, '@aspiralabs/config': AI_VERSION, '@aspiralabs/ui': AI_VERSION }
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    for (const name of ['ui', 'config']) {
      mkdirSync(join(root, 'node_modules', '@aspiralabs', name), { recursive: true })
      writeFileSync(join(root, 'node_modules', '@aspiralabs', name, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version: AI_VERSION }))
    }
    writeFileSync(join(root, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\nexport default next\n")
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: '@aspiralabs/config/tsconfig/next.json' }))
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'app', 'globals.css'), '@import "@aspiralabs/ui/tokens.css";\n')
    writeFileSync(join(root, 'AGENTS.md'), '<!-- aspiralabs:begin -->\n<!-- aspiralabs:end -->\n')
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': {} } }))
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: HOOKS.map((name) => ({ command: `sh .claude/hooks/aspira/${name}` })) }] } }))
    installHooks({ projectRoot: root, dryRun: false, log: () => {} })
    // The ignore lines doctor checks; the temp dir is not a git repository, so the git-based checks report skipped.
    writeFileSync(join(root, '.gitignore'), '.work/\n.aspira/\n.worktrees/\n.env.local\n')
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6' }))
  }

  it('fails on a missing folder and on a version mismatch, and passes after re-init', () => {
    const root = project()
    wire(root)
    const before = logs()
    expect(doctor(root, before.log)).toBe(1)
    expect(before.lines).toContain('FAIL .claude/skills/aspira-planner is missing')
    expect(before.lines.some((l) => l.startsWith('@aspiralabs/ai') && l.includes(`global ${KIT_VERSION}`))).toBe(true)

    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    const healthy = logs()
    expect(doctor(root, healthy.log)).toBe(0)
    expect(healthy.lines.filter((l) => l.startsWith('ok   .claude/skills/aspira-') && l.endsWith(' matches @aspiralabs/ai')).length).toBe(11)
    const checks = checkSkills(root)
    expect(checks.length).toBe(11)
    expect(checks.every((c) => c.ok && c.package === '@aspiralabs/ai')).toBe(true)

    // A skill from 0.15.0: the reason names the pinned version, the package and the installed version.
    writeFileSync(join(skillDir(root, 'pr-reviewer'), VERSION_FILE), '0.15.0\n')
    const stale = checkSkills(root)
    expect(stale.find((c) => c.reason?.includes('aspira-pr-reviewer'))?.reason).toBe(`.claude/skills/aspira-pr-reviewer is from 0.15.0, @aspiralabs/ai is ${KIT_VERSION}`)
    const mismatch = logs()
    expect(doctor(root, mismatch.log)).toBe(1)
    expect(mismatch.lines).toContain(`FAIL .claude/skills/aspira-pr-reviewer is from 0.15.0, @aspiralabs/ai is ${KIT_VERSION}`)

    rmSync(skillDir(root, 'implementor'), { recursive: true })
    expect(checkSkills(root).find((c) => c.reason?.includes('aspira-implementor'))?.reason).toBe('.claude/skills/aspira-implementor is missing')

    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    expect(doctor(root, () => {})).toBe(0)
  })

  it('installs .claude/skills/aspira-groomer with the others and reports it missing or stale like them', () => {
    const root = project()
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    const groomer = join(root, '.claude', 'skills', 'aspira-groomer')
    expect(readFileSync(join(groomer, VERSION_FILE), 'utf8')).toBe(`${KIT_VERSION}\n`)
    rmSync(groomer, { recursive: true })
    const missing = checkSkills(root).find((c) => c.reason?.includes('aspira-groomer'))
    expect(missing?.reason).toBe('.claude/skills/aspira-groomer is missing')
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    writeFileSync(join(groomer, VERSION_FILE), '0.15.0\n')
    const stale = checkSkills(root).find((c) => c.reason?.includes('aspira-groomer'))
    expect(stale?.reason).toBe(`.claude/skills/aspira-groomer is from 0.15.0, @aspiralabs/ai is ${KIT_VERSION}`)
  })

  it('fails while the project still declares @aspiralabs/ai, naming the remove command', () => {
    const root = project()
    wire(root)
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, [AI_PACKAGE]: KIT_VERSION } }))
    const { lines, log } = logs()
    expect(doctor(root, log)).toBe(1)
    expect(lines).toContain(`FAIL ${AI_PACKAGE} is in package.json; it is installed globally now: pnpm remove ${AI_PACKAGE}, then kit init`)
  })

  it('fails when a hook copy is missing from .claude/hooks/aspira/', () => {
    const root = project()
    wire(root)
    installSkills({ projectRoot: root, dryRun: false, log: () => {} })
    rmSync(join(root, HOOKS_DIR, 'deny-tier3.sh'))
    const { lines, log } = logs()
    expect(doctor(root, log)).toBe(1)
    expect(lines).toContain(`FAIL .claude/settings.json runs the hooks from ${HOOKS_DIR}`)
  })

  describe('the kit-owned skills', () => {
    /** A wired project with every skill installed: healthy until a case breaks one kit-owned skill. */
    function healthyProject(): string {
      const root = project()
      wire(root)
      installSkills({ projectRoot: root, dryRun: false, log: () => {} })
      return root
    }

    it('doctor prints eleven skill lines, all matching @aspiralabs/ai', () => {
      const { lines, log } = logs()
      expect(doctor(healthyProject(), log)).toBe(0)
      const skillLines = lines.filter((l) => l.includes('.claude/skills/aspira-'))
      expect(skillLines.length).toBe(11)
      for (const agent of AGENTS) expect(lines).toContain(`ok   .claude/skills/aspira-${agent} matches @aspiralabs/ai`)
      for (const name of KIT_OWNED) expect(lines, name).toContain(`ok   .claude/skills/aspira-${name} matches @aspiralabs/ai`)
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

    it('doctor fails on a kit-owned skill from another version, against the @aspiralabs/ai version', () => {
      const root = healthyProject()
      writeFileSync(join(kitSkill(root, 'worktree'), VERSION_FILE), '0.0.1\n')
      const { lines, log } = logs()
      expect(doctor(root, log)).toBe(1)
      expect(lines.some((l) => l.startsWith('FAIL') && l.includes('.claude/skills/aspira-worktree') && l.includes('is from 0.0.1') && l.includes('@aspiralabs/ai'))).toBe(true)
    })
  })
})
