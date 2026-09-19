'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@aspiralabs/ui'
import type { NavGroup, View } from '@/lib/docs'

export function Sidebar({ view, nav }: { view: View; nav: NavGroup[] }) {
  const pathname = usePathname()
  if (nav.length === 0) {
    return <p className="px-3 text-sm text-muted-foreground">Nothing migrated into this section yet.</p>
  }
  return (
    <nav className="flex flex-col">
      {nav.map((group) => (
        <div key={group.group} className="mt-5 flex flex-col gap-0.5 border-t border-border pt-5 first:mt-0 first:border-t-0 first:pt-0">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{group.group}</p>
          {group.items.map((item) => {
            const href = `/${view}/${item.slug}`
            const active = pathname === href
            return (
              <Link
                key={item.slug}
                href={href}
                className={cn(
                  'rounded-md px-3 py-2 text-left text-sm transition-colors',
                  active && 'bg-foreground text-background font-medium',
                  !active && 'text-foreground hover:bg-surface',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
