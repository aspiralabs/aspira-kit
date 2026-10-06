import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LAUNCH_FILES, PACKAGE_DIR, PACKAGE_NAME, packageDirFrom, packageFile } from '../agent/lib/package-dir.ts'
import { SEATS, type Reviewer } from '../agent/lib/review.ts'

const root = dirname(dirname(new URL(import.meta.url).pathname))
const reviewers: Reviewer[] = [...SEATS, 'quinn']
const launchFiles = [...reviewers.map((who) => LAUNCH_FILES.persona(who)), ...reviewers.map((who) => LAUNCH_FILES.sharedInstruction(who))]

type SnapshotModule = {
  createDevelopmentSourceSnapshotPlan: (input: { appRoot: string; snapshotRoot: string }) => Promise<{ copyFiles: readonly string[]; runtimeAppRoot: string; snapshotSourceRoot: string; sourceRoot: string }>
  toDevelopmentSourceSnapshotPath: (input: { snapshotSourceRoot: string; sourcePath: string; sourceRoot: string }) => string
}

// At launch eve runs the authored modules from a snapshot it plans with this very function: a copy
// of the compiled modules under <package>/.eve/dev-runtime/snapshots/<id>/source/, not the agent/
// tree. The bundle test covers a Node builtin reaching the workflow body; this one covers a file
// the runtime opens by path that the snapshot does not carry. It builds eve's own plan for this
// package, resolves the package directory from the snapshot location the way the runtime does, and
// requires every declared launch file to exist there. Rename one and it fails here, not in load-pr.
describe('files the runtime reads at launch', () => {
  it('resolves the real package directory from inside eve\'s snapshot plan, and finds every launch file there', async () => {
    const snapshot = (await import(pathToFileURL(join(root, 'node_modules', 'eve', 'dist', 'src', 'internal', 'nitro', 'dev-runtime-source-snapshot.js')).href)) as SnapshotModule
    await mkdir(join(root, '.eve', 'dev-runtime', 'snapshots'), { recursive: true })
    const snapshotRoot = await mkdtemp(join(root, '.eve', 'dev-runtime', 'snapshots', 'launch-test-'))
    try {
      const plan = await snapshot.createDevelopmentSourceSnapshotPlan({ appRoot: root, snapshotRoot })
      expect(plan.runtimeAppRoot.startsWith(snapshotRoot)).toBe(true)
      // Where a compiled authored module runs from at launch.
      const runtimeModule = pathToFileURL(join(plan.runtimeAppRoot, '.eve', 'compile', 'authored-modules', 'abc123.mjs')).href
      expect(packageDirFrom(runtimeModule)).toBe(root)
      expect(PACKAGE_DIR).toBe(root)
      // The old resolution, `../..` from the module, lands in the snapshot copy, where the personas are not.
      const oldPackageDir = resolve(dirname(join(plan.runtimeAppRoot, '.eve', 'compile', 'authored-modules', 'abc123.mjs')), '../..')
      for (const who of reviewers) expect(existsSync(join(oldPackageDir, LAUNCH_FILES.persona(who)))).toBe(false)
      // The snapshot plan copies compiled modules and package files, not the authored tree these readers need.
      for (const relative of launchFiles) {
        const snapshotPath = snapshot.toDevelopmentSourceSnapshotPath({ snapshotSourceRoot: plan.snapshotSourceRoot, sourcePath: join(root, relative), sourceRoot: plan.sourceRoot })
        expect(plan.copyFiles).not.toContain(snapshotPath)
        // So the runtime reads them from the real package directory, where every one of them must exist.
        expect(existsSync(packageFile(relative))).toBe(true)
      }
      expect(() => packageFile('agent/subagents/ava/instructions.md')).toThrow('is missing from')
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true })
    }
  })

  it('resolves the package from the source layout and from a build directory, and refuses anything else', () => {
    expect(packageDirFrom(pathToFileURL(join(root, 'agent', 'tools', 'load-pr.ts')).href)).toBe(root)
    expect(packageDirFrom(pathToFileURL(join(root, '.eve', 'builds', 'x', 'output', 'server', 'index.mjs')).href)).toBe(root)
    expect(packageDirFrom(pathToFileURL(join(root, '.eve', 'compile', 'authored-modules', 'x.mjs')).href)).toBe(root)
    expect(() => packageDirFrom(pathToFileURL('/tmp/nowhere/index.mjs').href)).toThrow(PACKAGE_NAME)
  })
})
