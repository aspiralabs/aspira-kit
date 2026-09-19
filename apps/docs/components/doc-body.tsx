'use client'

// Evaluates a compiled MDX function body with the docs scope and renders it.
// Mirrors what next-mdx-remote does, minus its export stripping.
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { mdxComponents, mdxScope } from '@/components/mdx'

type MdxModule = { default: React.ComponentType<{ components?: Record<string, unknown> }> }

function build(code: string): MdxModule {
  // A doc may export a name that also exists in the scope (input-otp exports its
  // own FormDemo). The doc's declaration wins, so leave those out of the destructure.
  const declared = new Set([...code.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
  const keys = Object.keys(mdxScope).filter((k) => !declared.has(k))
  const body = code.replace(/(= arguments\[0\];?)/, `$1\nconst { ${keys.join(', ')} } = arguments[1];`)
  const fn = new Function(body) as (rt: unknown, scope: Record<string, unknown>) => MdxModule
  return fn(runtime, mdxScope)
}

class DocErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold text-destructive">This doc failed to render.</p>
          <pre className="mt-2 overflow-x-auto text-xs text-foreground-subtext">{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

export function DocBody({ code }: { code: string }) {
  const mod = React.useMemo(() => build(code), [code])
  const Content = mod.default
  return (
    <DocErrorBoundary>
      <Content components={mdxComponents} />
    </DocErrorBoundary>
  )
}
