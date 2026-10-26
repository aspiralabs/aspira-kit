import { defineConfig } from 'vitest/config'

// Every test builds its own temp fixture and removes it when it finishes, so no test depends on
// another: tests inside a file run concurrently too, not only files side by side.
export default defineConfig({
  test: {
    sequence: { concurrent: true },
    // No test reads or writes the machine's global git config or ignore (../git-setup.ts).
    setupFiles: ['../git-setup.ts'],
  },
})
