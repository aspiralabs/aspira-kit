import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { cn } from '@aspiralabs/ui'
import { firstSlug, navFor, uiVersion, VIEWS, type View } from '@/lib/docs'

export function generateStaticParams() {
  return VIEWS.map((v) => ({ view: v.id }))
}

export default async function ViewLayout({ children, params }: { children: ReactNode; params: Promise<{ view: string; slug?: string }> }) {
  const { view } = await params
  const meta = VIEWS.find((v) => v.id === view)
  if (!meta) {
    notFound()
  }
  const nav = navFor(meta.id)

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold tracking-tight">Aspira Kit</span>
          <nav className="flex items-center gap-1">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={`/${v.id}/${firstSlug(v.id) ?? ''}`}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  v.id === meta.id && 'bg-foreground text-background font-medium',
                  v.id !== meta.id && 'text-foreground-subtext hover:bg-surface hover:text-foreground',
                )}
              >
                {v.label}
              </Link>
            ))}
          </nav>
        </div>
        <span className="text-xs text-muted-foreground">@aspiralabs/ui {uiVersion()}</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface/40 p-4">
          <Sidebar view={meta.id} nav={nav} />
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-10 py-16">{children}</div>
        </main>
      </div>
    </div>
  )
}

function Sidebar({ view, nav }: { view: View; nav: ReturnType<typeof navFor> }) {
  if (nav.length === 0) {
    return <p className="px-3 text-sm text-muted-foreground">Nothing migrated into this section yet.</p>
  }
  return (
    <nav className="flex flex-col">
      {nav.map((group) => (
        <div key={group.group} className="mt-5 flex flex-col gap-0.5 border-t border-border pt-5 first:mt-0 first:border-t-0 first:pt-0">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{group.group}</p>
          {group.items.map((item) => (
            <SidebarLink key={item.slug} href={`/${view}/${item.slug}`} label={item.label} />
          ))}
        </div>
      ))}
    </nav>
  )
}

function SidebarLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 text-left text-sm text-foreground-subtext transition-colors hover:bg-surface hover:text-foreground data-[active=true]:bg-foreground data-[active=true]:font-medium data-[active=true]:text-background"
    >
      {label}
    </Link>
  )
}
