// The map's graph: one node:sqlite database in map/. Nodes with package and surface, edges (internal, external,
// unresolved), env reads, exported symbols, packages, and the per-file index cache keyed by path and hash.
// Written once per build into a temporary folder and renamed into place; readers open it read-only.

import { DatabaseSync } from 'node:sqlite'
import type { Edge, SyntaxFacts } from './imports.ts'

export const GRAPH_FILE = 'graph.db'

export const SCHEMA = `
create table nodes (path text primary key, hash text not null, package text not null, package_dir text not null, surface text not null, language text not null);
create table packages (dir text primary key, name text not null);
create table edges (source text not null, specifier text not null, kind text not null, target text not null, type_only integer not null);
create table env_reads (name text not null, path text not null);
create table symbols (name text not null, path text not null);
create table index_cache (path text primary key, hash text not null, scanner text not null, facts text not null);
create index edges_source on edges (source);
create index edges_target on edges (target);
create index env_name on env_reads (name);
create index symbol_name on symbols (name);
`

export type NodeRow = { path: string; hash: string; package: string; packageDir: string; surface: string; language: string }
export type PackageRow = { dir: string; name: string }
export type Graph = { nodes: NodeRow[]; packages: PackageRow[]; edges: Edge[]; envReads: { name: string; path: string }[]; symbols: { name: string; path: string }[] }
export type CacheEntry = { hash: string; scanner: string; facts: SyntaxFacts }

export function writeGraph(file: string, graph: Graph, cache: Map<string, CacheEntry>): void {
  const db = new DatabaseSync(file)
  try {
    db.exec(SCHEMA)
    db.exec('begin')
    const insert = (sql: string, rows: unknown[][]): void => {
      const statement = db.prepare(sql)
      for (const row of rows) statement.run(...(row as (string | number)[]))
    }
    insert('insert into nodes values (?, ?, ?, ?, ?, ?)', graph.nodes.map((n) => [n.path, n.hash, n.package, n.packageDir, n.surface, n.language]))
    insert('insert into packages values (?, ?)', graph.packages.map((p) => [p.dir, p.name]))
    insert('insert into edges values (?, ?, ?, ?, ?)', graph.edges.map((e) => [e.source, e.specifier, e.kind, e.target, e.typeOnly ? 1 : 0]))
    insert('insert into env_reads values (?, ?)', graph.envReads.map((e) => [e.name, e.path]))
    insert('insert into symbols values (?, ?)', graph.symbols.map((s) => [s.name, s.path]))
    insert('insert into index_cache values (?, ?, ?, ?)', [...cache].map(([path, entry]) => [path, entry.hash, entry.scanner, JSON.stringify(entry.facts)]))
    db.exec('commit')
  } finally {
    db.close()
  }
}

/** The whole graph, read-only; undefined when the file is absent or unreadable. */
export function readGraph(file: string): Graph | undefined {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return undefined
  }
  try {
    const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[]
    return {
      nodes: all<{ path: string; hash: string; package: string; package_dir: string; surface: string; language: string }>('select * from nodes order by path').map((n) => ({ path: n.path, hash: n.hash, package: n.package, packageDir: n.package_dir, surface: n.surface, language: n.language })),
      packages: all<PackageRow>('select * from packages order by dir'),
      edges: all<{ source: string; specifier: string; kind: Edge['kind']; target: string; type_only: number }>('select * from edges order by source, specifier, target').map((e) => ({ source: e.source, specifier: e.specifier, kind: e.kind, target: e.target, typeOnly: e.type_only === 1 })),
      envReads: all<{ name: string; path: string }>('select * from env_reads order by name, path'),
      symbols: all<{ name: string; path: string }>('select * from symbols order by name, path'),
    }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** The previous build's per-file cache, for reuse; empty when there is no readable graph. */
export function readCache(file: string): Map<string, CacheEntry> {
  const cache = new Map<string, CacheEntry>()
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return cache
  }
  try {
    for (const row of db.prepare('select * from index_cache').all() as { path: string; hash: string; scanner: string; facts: string }[]) {
      try {
        cache.set(row.path, { hash: row.hash, scanner: row.scanner, facts: JSON.parse(row.facts) as SyntaxFacts })
      } catch {
        // a damaged cache row is a miss: the file is parsed again
      }
    }
  } catch {
    // no cache table: nothing to reuse
  } finally {
    db.close()
  }
  return cache
}
