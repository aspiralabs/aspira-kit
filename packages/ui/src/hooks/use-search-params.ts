'use client'

// Router-free replacement for next/navigation's useSearchParams: reads
// window.location.search and re-renders on popstate. Server snapshot is empty.
import { useSyncExternalStore } from 'react'

const EMPTY = new URLSearchParams()
let cached = { search: '', params: EMPTY }

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener)
  return () => window.removeEventListener('popstate', listener)
}

function getSnapshot(): URLSearchParams {
  const search = window.location.search
  if (search !== cached.search) {
    cached = { search, params: new URLSearchParams(search) }
  }
  return cached.params
}

export function useSearchParams(): URLSearchParams {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)
}
