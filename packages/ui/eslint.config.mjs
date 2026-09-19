import library from '@aspiralabs/config/eslint/library'

export default [
  ...library,
  {
    // Migration debt (2026-09-19): 49 JSX ternaries came over from SAAS_BOILER
    // across 17 files. Tracked in packages/config/agent/slop-register.md. Remove
    // this override as files are rewritten.
    files: ['src/**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
