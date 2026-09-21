import { defineConfig } from 'vitest/config'

// Component specs, co-located as src/**/<name>.test.tsx. jsdom for the DOM,
// testing-library for queries, jest-dom matchers from the setup file. Tests are
// excluded from the tsc build (tsconfig.json) and transpiled here by esbuild.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx'],
  },
  esbuild: { jsx: 'automatic' },
})
