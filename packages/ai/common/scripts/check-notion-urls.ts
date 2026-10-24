// `kit doctor` runs this (its liveUrlChecker) the way `kit next` runs resolve-ticket.ts: with
// NOTION_TOKEN from the project's .env.local (passed in as --env-file flags, the app's winning).
// Args are "key=url" pairs, one per aspira.json Notion key present. Prints one "key=status" line
// per argument and never the token. `board` resolves as a database (or a data source for a
// collection:// value); every other key resolves as a page.
import { checkNotionUrls, type UrlCheck } from '../src/lib/notion-url-check.ts'

function kindOf(key: string, url: string): UrlCheck['kind'] {
  if (key !== 'board') return 'page'
  return url.trim().toLowerCase().startsWith('collection://') ? 'data_source' : 'database'
}

function parse(args: string[]): UrlCheck[] {
  return args.flatMap((arg) => {
    const at = arg.indexOf('=')
    if (at < 1) return []
    const key = arg.slice(0, at)
    const url = arg.slice(at + 1)
    return [{ key, url, kind: kindOf(key, url) }]
  })
}

async function main(): Promise<void> {
  const checks = parse(process.argv.slice(2))
  if (checks.length === 0) return
  const token = process.env.NOTION_TOKEN?.trim()
  if (!token) {
    for (const check of checks) console.log(`${check.key}=unreachable:no NOTION_TOKEN`)
    return
  }
  const results = await checkNotionUrls(checks, { token })
  for (const check of checks) {
    const result = results[check.key]
    if (result === undefined) continue
    if (result.ok) console.log(`${check.key}=ok`)
    else if (result.unreachable) console.log(`${check.key}=unreachable:${result.reason.replaceAll('\n', ' ')}`)
    else console.log(`${check.key}=failed:${result.status ?? ''}:${result.reason.replaceAll('\n', ' ')}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`check-notion-urls: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
