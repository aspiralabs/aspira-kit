// The entry `kit map-codebase` spawns (node + amaro strip-types): the kit resolves the repo and the map root and passes
// them as --repo and --map-root. No command builds the map; --check reports freshness (exit 0 fresh, 1 missing or stale).

import { parseArgs } from 'node:util'
import { dirname } from 'node:path'
import { buildMap, checkMap } from '../src/build.ts'
import { BriefError, TARGET_KINDS, brief, formatBrief, type TargetKind } from '../src/brief.ts'
import { mapDirs } from '../src/map-root.ts'

const USAGE = 'usage: map-codebase --repo <dir> --map-root <dir> [--check] [brief <target>... [--json] [--kind k] [--changed] | notes [accept|retire <id>]]'

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: false, options: { repo: { type: 'string' }, 'map-root': { type: 'string' }, check: { type: 'boolean' }, json: { type: 'boolean' }, kind: { type: 'string' }, changed: { type: 'boolean' } } })
  const repo = typeof values.repo === 'string' ? values.repo : undefined
  const mapRoot = typeof values['map-root'] === 'string' ? values['map-root'] : undefined
  const [command] = positionals
  if (repo === undefined || mapRoot === undefined || (command !== undefined && command !== 'brief')) {
    console.error(USAGE)
    return 2
  }
  // the build functions keep their map in <root>/map: hand them the folder that holds this repo's map/
  if (command === 'brief') {
    const kind = values.kind
    if (kind !== undefined && !(typeof kind === 'string' && (TARGET_KINDS as readonly string[]).includes(kind))) {
      console.error(`map-codebase: --kind is one of ${TARGET_KINDS.join(', ')}`)
      return 2
    }
    try {
      const packet = await brief({ repo, mapRoot, targets: positionals.slice(1), changed: values.changed === true, kind: kind as TargetKind | undefined })
      console.log(values.json === true ? JSON.stringify(packet, null, 2) : formatBrief(packet))
      return 0
    } catch (error) {
      if (!(error instanceof BriefError)) throw error
      console.error(`map-codebase: ${error.message}`)
      return 1
    }
  }
  const root = dirname((await mapDirs(repo, mapRoot)).mapDir)
  if (values.check === true) {
    const freshness = await checkMap(repo, root)
    if (freshness.state === 'fresh') {
      console.log(`fresh: the map in ${mapRoot} matches the repo`)
      return 0
    }
    if (freshness.state === 'missing') {
      console.log(`missing: no map in ${mapRoot}; run kit map-codebase`)
      return 1
    }
    console.log(`stale: ${freshness.reasons.join('; ')}`)
    for (const path of freshness.changed) console.log(`  ${path}`)
    console.log('run kit map-codebase to refresh it')
    return 1
  }
  const summary = await buildMap(repo, root)
  console.log(`map root: ${summary.mapRoot}`)
  console.log(`commit: ${summary.commit.slice(0, 7)}`)
  console.log(`${summary.files} files`)
  console.log(`${summary.internal} internal edges`)
  console.log(`${summary.external} external edges`)
  console.log(`${summary.unresolved} unresolved specifiers`)
  console.log(`${summary.parsed} parsed`)
  console.log(`${summary.reused} reused`)
  console.log(`${summary.removed} removed`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`map-codebase: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
