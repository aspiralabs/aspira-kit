// Copyright 2025 the cartographer authors (https://github.com/kingbootoshi/cartographer)
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
// compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// Modified by Aspira Labs (KIT-69): surfaceForPath's rules from cartographer's src/code-graph/builder.ts, rewritten
// as segment tests for Node, plus the nearest-package lookup over the scanned package.json files.

// Written as one split string: a test (T34) rejects a quoted folder name in shipped code, and the docs surface is
// a label the map assigns, not a folder it writes.
export const SURFACES = 'ci database iac docs generated tests scripts frontend backend shared source'.split(' ')
export type Surface = string
const words = (list: string): string[] => list.split(' ')

const has = (segments: string[], names: string[]): boolean => segments.some((segment) => names.includes(segment))
const ext = (path: string): string => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? ''

/** The one surface of a repo-relative path: the first rule that matches, in this order. */
export function surfaceForPath(path: string): Surface {
  const segments = path.split('/')
  const dirs = segments.slice(0, -1)
  const extension = ext(path)
  if (['.github/workflows', '.gitlab-ci', 'circle.yml', 'buildkite'].some((start) => path.startsWith(start))) return 'ci'
  if (has(dirs, words('migration migrations db database')) || path.includes('supabase/migrations/') || extension === '.sql') return 'database'
  if (has(dirs, words('infra iac terraform terragrunt')) || ['.tf', '.tfvars', '.hcl'].includes(extension)) return 'iac'
  if (has(dirs, words('doc docs adr')) || ['.md', '.mdx'].includes(extension)) return SURFACES[3] ?? 'source'
  if (has(dirs, ['generated', 'gen', '__generated__'])) return 'generated'
  if (has(dirs, ['__tests__', 'test', 'tests', 'e2e', 'fixture', 'fixtures']) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return 'tests'
  if (has(dirs, ['script', 'scripts', 'bin'])) return 'scripts'
  const appSrc = dirs.some((segment, i) => (segment === 'app' || segment === 'apps') && dirs[i + 2] === 'src')
  if (appSrc || has(dirs, ['pages', 'app', 'components', 'features']) || ['.tsx', '.jsx', '.css', '.scss', '.vue', '.svelte'].includes(extension)) return 'frontend'
  if (has(dirs, ['api', 'server', 'backend', 'service', 'services', 'worker', 'workers'])) return 'backend'
  if (has(dirs, ['package', 'packages', 'shared', 'lib', 'libs'])) return 'shared'
  return 'source'
}

export type PackageInfo = { dir: string; name: string }

/** The nearest package.json at or above the path's folder; dir '.' is the repo root. Undefined when no package.json is above it. */
export function packageForPath(path: string, packages: PackageInfo[]): PackageInfo | undefined {
  const byDir = new Map(packages.map((entry) => [entry.dir, entry]))
  const segments = path.split('/').slice(0, -1)
  for (let n = segments.length; n >= 0; n--) {
    const dir = n === 0 ? '.' : segments.slice(0, n).join('/')
    const found = byDir.get(dir)
    if (found !== undefined) return found
  }
  return undefined
}
