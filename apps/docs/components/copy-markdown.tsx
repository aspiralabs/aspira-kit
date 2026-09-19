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
  const label = copied && 'Copied' || 'Copy markdown'
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {label}
    </Button>
  )
}
