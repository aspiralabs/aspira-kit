'use client'

import { useState } from 'react'
import { Button } from '@aspiralabs/ui'

export function CopyMarkdown({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard can be blocked; leave the button idle
    }
  }
  const label = copied && 'Copied' || 'Markdown'
  return (
    <Button variant="outline" onClick={copy} className="shrink-0">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="9" y="9" width="13" height="13" rx="1" />
        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
      </svg>
      {label}
    </Button>
  )
}
