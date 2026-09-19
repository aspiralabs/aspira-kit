import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Button } from '@aspiralabs/ui'
import { Sidebar } from '@/components/sidebar'
import { ThemeToggle } from '@/components/theme-toggle'
import { firstSlug, navFor, uiVersion, VIEWS } from '@/lib/docs'

export function generateStaticParams() {
  return VIEWS.map((v) => ({ view: v.id }))
}

// Mirrors SAAS_BOILER's Page.Header (title, divider, tab buttons) and the
// DocsView split (sidebar + scrolling main) from admin/design-system.
export default async function ViewLayout({ children, params }: { children: ReactNode; params: Promise<{ view: string }> }) {
  const { view } = await params
  const meta = VIEWS.find((v) => v.id === view)
  if (!meta) {
    notFound()
  }
  const nav = navFor(meta.id)

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-8">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="whitespace-nowrap text-2xl font-semibold text-foreground">Design System</h1>
          <div className="h-5 w-px shrink-0 bg-border" />
          <div className="flex items-center gap-1">
            {VIEWS.map((v) => {
              const variant = v.id === meta.id && 'default' || 'ghost'
              return (
                <Button key={v.id} variant={variant} asChild>
                  <Link href={`/${v.id}/${firstSlug(v.id) ?? ''}`}>{v.label}</Link>
                </Button>
              )
            })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground">@aspiralabs/ui {uiVersion()}</span>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border p-4">
          <Sidebar view={meta.id} nav={nav} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-10 py-16">{children}</div>
        </main>
      </div>
    </div>
  )
}
