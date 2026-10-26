import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The one test entry of @aspiralabs/ai: the kit's suites (src/**/*.test.ts, including the install test, which
// packs the package into a scratch project and runs a launcher from node_modules, so it takes longer), the
// build-feature and visual-verify suites, and every agent folder's suite. The agent suites were outside this
// entry until KIT-71 and drifted unnoticed; each runs from its own folder with the host's knowledge settings
// cleared (agents-setup.ts), so a developer's KNOWLEDGE_PAGE never reaches a fixture.
const AGENTS = ['common', 'groomer', 'spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer']
const SETUP = fileURLToPath(new URL('./agents-setup.ts', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'kit',
          include: ['src/**/*.test.ts'],
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
      './build-feature/vitest.config.ts',
      './visual-verify/vitest.config.ts',
      // The launcher and driver tests spawn bash, git and node, which outgrow vitest's 5s default once every suite shares the machine.
      ...AGENTS.map((agent) => ({ test: { name: agent, root: `./${agent}`, setupFiles: [SETUP], testTimeout: 60_000, hookTimeout: 60_000 } })),
    ],
  },
})
