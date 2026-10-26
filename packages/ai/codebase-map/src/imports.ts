// Import extraction and resolution with the TypeScript compiler: the AST finds every specifier (import, import type,
// export ... from, dynamic import() with a string literal, multi-line), ts.resolveModuleName resolves it.

import { builtinModules } from 'node:module'
import { realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { envNamesIn } from './env.ts'

export const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/

export type ImportFact = { specifier: string; typeOnly: boolean; form: 'import' | 'export' | 'dynamic' }
/** What one file says on its own, independent of every other file: cached by the file's hash. */
export type SyntaxFacts = { imports: ImportFact[]; exports: string[]; env: string[] }
export type Edge = { source: string; specifier: string; kind: 'internal' | 'external' | 'unresolved'; target: string; typeOnly: boolean }

const kindFor = (path: string): ts.ScriptKind => (path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

export function extractFacts(path: string, text: string): SyntaxFacts {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindFor(path))
  const imports: ImportFact[] = []
  const exported = new Set<string>()
  const hasExport = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const isDefault = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly === true, form: 'import' })
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, form: 'export' })
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) exported.add(element.name.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteralLike(first)) imports.push({ specifier: first.text, typeOnly: false, form: 'dynamic' })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      imports.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly, form: 'import' })
    } else if (ts.isExportAssignment(node)) {
      exported.add('default')
    } else if (hasExport(node)) {
      if (isDefault(node)) exported.add('default')
      else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text)
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name !== undefined) exported.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, exports: [...exported].sort(), env: envNamesIn(text) }
}

const BUILTINS = new Set(builtinModules)
const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0] ?? specifier)

/** The npm package name of a bare specifier: `@scope/name` or `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

export type ResolveContext = { repo: string; files: ReadonlySet<string> }

const OPTIONS: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, resolveJsonModule: true, allowImportingTsExtensions: true }

export function resolveEdges(context: ResolveContext, facts: ReadonlyMap<string, SyntaxFacts>): Edge[] {
  const host: ts.ModuleResolutionHost = { ...ts.sys, realpath: (path) => { try { return realpathSync(path) } catch { return path } } }
  const cache = ts.createModuleResolutionCache(context.repo, (name) => name, OPTIONS)
  const edges: Edge[] = []
  for (const [source, fact] of facts) {
    for (const entry of fact.imports) {
      const edge = (kind: Edge['kind'], target: string): Edge => ({ source, specifier: entry.specifier, kind, target, typeOnly: entry.typeOnly })
      if (isBuiltin(entry.specifier)) {
        edges.push(edge('external', entry.specifier))
        continue
      }
      const resolved = ts.resolveModuleName(entry.specifier, join(context.repo, source), OPTIONS, host, cache).resolvedModule
      if (resolved === undefined) {
        edges.push(edge('unresolved', ''))
        continue
      }
      const real = host.realpath?.(resolved.resolvedFileName) ?? resolved.resolvedFileName
      const rel = relative(context.repo, real).split(sep).join('/')
      const inside = !rel.startsWith('..') && !rel.split('/').includes('node_modules')
      if (inside && context.files.has(rel)) edges.push(edge('internal', rel))
      else if (resolved.isExternalLibraryImport === true || !inside) edges.push(edge('external', resolved.packageId?.name ?? packageName(entry.specifier)))
      else edges.push(edge('unresolved', ''))
    }
  }
  return edges
}
