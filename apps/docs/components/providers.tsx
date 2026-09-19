'use client'

// The same providers SAAS_BOILER's app/providers.tsx mounts, so Modal, Drawer,
// Tooltip, Toast, BlockUI, and the infinite table demos work on the docs site.
import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import NiceModal from '@ebay/nice-modal-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToasterPrimitive, TooltipProviderPrimitive, useBlockUIState } from '@aspiralabs/ui'

const queryClient = new QueryClient()
const subscribe = () => () => {}
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false)

function Overlays() {
  const blockState = useBlockUIState()
  const mounted = useMounted()
  if (!mounted || !blockState.blocked) {
    return null
  }
  return createPortal(
    <div
      style={{ zIndex: 2147483649 }}
      className="pointer-events-none fixed top-0 left-0 flex h-screen w-screen flex-col items-center justify-center bg-background/80"
    >
      <svg className="animate-spin text-primary" width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {blockState.reason && <p className="mt-2 text-sm text-primary">{blockState.reason}</p>}
    </div>,
    document.body,
  )
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProviderPrimitive>
        <NiceModal.Provider>{children}</NiceModal.Provider>
      </TooltipProviderPrimitive>
      <ToasterPrimitive />
      <Overlays />
    </QueryClientProvider>
  )
}
