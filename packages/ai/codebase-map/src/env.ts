// Env var NAMES read in code: process.env.X, process.env['X'] and import.meta.env.X. A value is never read:
// the text scanned is a source file's own, never a .env* file's.

const PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /import\.meta\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
]

export function envNamesIn(text: string): string[] {
  const names = new Set<string>()
  for (const pattern of PATTERNS) for (const match of text.matchAll(pattern)) if (match[1] !== undefined) names.add(match[1])
  return [...names].sort()
}
