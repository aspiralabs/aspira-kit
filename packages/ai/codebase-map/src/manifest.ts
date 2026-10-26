// Copyright 2025 the cartographer authors (https://github.com/kingbootoshi/cartographer)
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
// compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// Modified by Aspira Labs (KIT-69): cartographer's manifest and verify --fresh freshness check, with the manifest
// validated by zod on read, a repo identity (root commit and main checkout) and the comparison --check prints.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const MANIFEST_FILE = 'manifest.json'

export const Manifest = z.object({
  version: z.literal(1),
  scanner: z.string(),
  commit: z.string(),
  dirty: z.array(z.string()),
  repo: z.object({ rootCommit: z.string(), mainCheckout: z.string() }),
  files: z.record(z.string(), z.string()),
})
export type Manifest = z.infer<typeof Manifest>

/** The manifest of the complete map in `mapDir` (`<map root>/map`); undefined when there is none or it is unreadable. */
export async function readManifest(mapDir: string): Promise<Manifest | undefined> {
  try {
    const parsed = Manifest.safeParse(JSON.parse(await readFile(join(mapDir, MANIFEST_FILE), 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export type Current = Pick<Manifest, 'scanner' | 'commit' | 'dirty' | 'files'>
export type Freshness = { state: 'missing' } | { state: 'fresh' } | { state: 'stale'; reasons: string[]; changed: string[] }

/** fresh when the manifest matches the repo now; else stale with the changed files and what differs. */
export function compareManifest(manifest: Manifest | undefined, current: Current): Freshness {
  if (manifest === undefined) return { state: 'missing' }
  const reasons: string[] = []
  const changed = new Set<string>()
  if (manifest.scanner !== current.scanner) reasons.push(`scanner version ${manifest.scanner} -> ${current.scanner}`)
  if (manifest.commit !== current.commit) reasons.push(`commit ${manifest.commit.slice(0, 7)} -> ${current.commit.slice(0, 7)}`)
  for (const path of new Set([...Object.keys(manifest.files), ...Object.keys(current.files)])) if (manifest.files[path] !== current.files[path]) changed.add(path)
  const before = new Set(manifest.dirty)
  const now = new Set(current.dirty)
  for (const path of before) if (!now.has(path)) changed.add(path)
  for (const path of now) if (!before.has(path)) changed.add(path)
  if (changed.size > 0) reasons.push(`${changed.size} file${changed.size === 1 ? '' : 's'} changed`)
  return reasons.length === 0 ? { state: 'fresh' } : { state: 'stale', reasons, changed: [...changed].sort() }
}
