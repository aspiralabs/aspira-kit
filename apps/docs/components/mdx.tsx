// The component map for rendering a doc. Ported from SAAS_BOILER's
// design-system-mdx.tsx: markdown elements get the design-system page styling,
// and the ui components are in scope so MDX bodies render real demos.
import type { ComponentProps, ReactNode } from 'react'
import { highlight } from 'sugar-high'
import { Button, cn } from '@aspiralabs/ui'

function Demo({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mt-3 max-w-2xl space-y-3', className)}>{children}</div>
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="text-lg text-foreground-subtext">{children}</p>
}

function codeText(children: ReactNode): string | undefined {
  if (typeof children === 'string') {
    return children
  }
  if (children && typeof children === 'object' && 'props' in children) {
    const inner = (children as { props: { children?: ReactNode } }).props.children
    return typeof inner === 'string' ? inner : undefined
  }
  return undefined
}

export const mdxComponents = {
  h2: ({ className, ...props }: ComponentProps<'h2'>) => (
    <h2 className={cn('mt-12 mb-3 scroll-m-20 text-2xl font-semibold text-foreground first:mt-0', className)} {...props} />
  ),
  h3: ({ className, ...props }: ComponentProps<'h3'>) => (
    <h3 className={cn('mt-8 mb-2 scroll-m-20 text-sm font-semibold text-foreground', className)} {...props} />
  ),
  p: ({ className, ...props }: ComponentProps<'p'>) => <p className={cn('text-base text-foreground-subtext', className)} {...props} />,
  a: ({ className, ...props }: ComponentProps<'a'>) => <a className={cn('font-medium underline underline-offset-4', className)} {...props} />,
  ul: ({ className, ...props }: ComponentProps<'ul'>) => <ul className={cn('mt-2 ml-6 list-disc text-base text-foreground-subtext', className)} {...props} />,
  ol: ({ className, ...props }: ComponentProps<'ol'>) => <ol className={cn('mt-2 ml-6 list-decimal text-base text-foreground-subtext', className)} {...props} />,
  li: ({ className, ...props }: ComponentProps<'li'>) => <li className={cn('mt-1', className)} {...props} />,
  code: ({ className, ...props }: ComponentProps<'code'>) => (
    <code className={cn('rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-foreground', className)} {...props} />
  ),
  pre: ({ className, children, ...props }: ComponentProps<'pre'>) => {
    const base = 'mt-3 overflow-x-auto rounded-lg border border-border bg-surface p-4 text-sm leading-relaxed'
    const text = codeText(children)
    if (text) {
      return (
        <pre className={cn(base, className)} {...props}>
          <code dangerouslySetInnerHTML={{ __html: highlight(text) }} />
        </pre>
      )
    }
    return (
      <pre className={cn(base, className)} {...props}>
        {children}
      </pre>
    )
  },
  table: ({ className, ...props }: ComponentProps<'table'>) => (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      {/* eslint-disable-next-line no-restricted-syntax -- this is the markdown table renderer, the one place a raw table belongs */}
      <table className={cn('w-full text-sm', className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }: ComponentProps<'thead'>) => <thead className={cn('border-b border-border bg-surface', className)} {...props} />,
  tr: ({ className, ...props }: ComponentProps<'tr'>) => <tr className={cn('border-b border-border last:border-b-0', className)} {...props} />,
  th: ({ className, ...props }: ComponentProps<'th'>) => <th className={cn('px-4 py-2 text-left font-semibold', className)} {...props} />,
  td: ({ className, ...props }: ComponentProps<'td'>) => <td className={cn('px-4 py-2 align-top text-foreground-subtext', className)} {...props} />,

  Demo,
  Lead,

  // ui components in scope for demos. Grows as components migrate into the package.
  Button,
}
