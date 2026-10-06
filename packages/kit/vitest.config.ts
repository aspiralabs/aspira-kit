import { defineConfig } from 'vitest/config'

// Unit tests sit next to the source (src/**/*.test.ts); the install test packs the agent packages
// into a scratch project and runs a launcher from node_modules, so it takes longer.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
