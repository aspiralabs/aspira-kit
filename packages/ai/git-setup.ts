// Setup for every suite of this package (vitest.config.ts, build-feature and visual-verify configs): no test reads
// or writes the machine's own global git config, global git ignore or ~/.claude. The kit's self-heal (KIT-71) adds
// aspira.json, .work/ and .worktrees/ to the global ignore at core.excludesFile, else $XDG_CONFIG_HOME/git/ignore,
// else ~/.config/git/ignore. A test that gave the kit a temp HOME but kept the CI runner's XDG_CONFIG_HOME wrote the
// runner's real ignore, and every fixture that later committed aspira.json or .work/ then silently left it out.
// Each test file gets its own empty HOME, no XDG_CONFIG_HOME (so a test's own temp HOME holds its global ignore)
// and no inherited GIT_CONFIG_GLOBAL, and a git identity in the environment so commits need no config.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'kit-home-'))
for (const name of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG']) delete process.env[name]
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'kit test',
  GIT_AUTHOR_EMAIL: 'kit-test@example.com',
  GIT_COMMITTER_NAME: 'kit test',
  GIT_COMMITTER_EMAIL: 'kit-test@example.com',
})
afterAll(() => rmSync(home, { recursive: true, force: true }))
