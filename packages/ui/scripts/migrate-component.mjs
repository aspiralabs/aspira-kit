#!/usr/bin/env node
// Copy one component and its doc from SAAS_BOILER into this package, rewriting
// import paths. Usage: node scripts/migrate-component.mjs badge [--boiler <path>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..')
const args = process.argv.slice(2)
const name = args[0]
const boiler = args.includes('--boiler') ? args[args.indexOf('--boiler') + 1] : '/Users/davidludemann/Documents/DEVELOPMENT/PRODUCTS/SAAS_BOILER/web-app'
if (!name) {
  console.error('usage: migrate-component <name> [--boiler <path>]')
  process.exit(2)
}
const src = join(boiler, 'components', 'ui', 'core', name)
const dst = join(pkg, 'src', 'components', name)
if (!existsSync(src)) {
  console.error(`not found: ${src}`)
  process.exit(1)
}
mkdirSync(dst, { recursive: true })
for (const f of readdirSync(src)) {
  if (f.includes('.test.')) {
    continue
  }
  let text = readFileSync(join(src, f), 'utf8')
  text = text
    .replace(/from '@\/lib\/utils'/g, "from '../../lib/cn.js'")
    .replace(/from '@\/components\/ui\/core\/([a-z-]+)'/g, "from '../$1/index.js'")
    .replace(/from '@\/components\/ui\/primitives\/([a-z-]+)'/g, "from '../../primitives/$1.js'")
    .replace(/from '\.\/([a-z-]+)'/g, "from './$1.js'")
  writeFileSync(join(dst, f), text)
}
const doc = join(boiler, 'content', 'design-system', `${name}.mdx`)
if (existsSync(doc)) {
  const text = readFileSync(doc, 'utf8').replace(/@\/components\/ui\/core\/[a-z-]+/g, '@aspiralabs/ui')
  writeFileSync(join(pkg, 'docs', `${name}.mdx`), text)
}
const index = join(pkg, 'src', 'index.ts')
const line = `export * from './components/${name}/index.js'\n`
if (!readFileSync(index, 'utf8').includes(line)) {
  writeFileSync(index, readFileSync(index, 'utf8') + line)
}
console.log(`migrated ${name}: ${readdirSync(dst).join(', ')}${existsSync(doc) ? ' + docs' : ''}`)
console.log('now: fix any remaining @/ imports, check for hardcoded radius/colors, run pnpm check')
