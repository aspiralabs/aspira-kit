import { defineConfig } from 'vitest/config'

// The one test entry of @aspiralabs/ai: the kit's suites (src/**/*.test.ts, including the install test, which
// packs the package into a scratch project and runs a launcher from node_modules, so it takes longer) plus the
// build-feature and visual-verify suites. The other agent folders' suites run with
// `vitest run --root <folder>`.
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
    ],
  },
})
