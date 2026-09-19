'use client';

import { useSyncExternalStore } from 'react';

interface BlockUIState {
    blocked: boolean;
    reason: string | null;
}

const initialState: BlockUIState = { blocked: false, reason: null };
let state: BlockUIState = initialState;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): BlockUIState {
    return state;
}

function getServerSnapshot(): BlockUIState {
    return initialState;
}

export function BlockUI(value: boolean, reason: string | null = null) {
    const next: BlockUIState = value
        ? { blocked: true, reason }
        : { blocked: false, reason: null };
    if (next.blocked === state.blocked && next.reason === state.reason) return;
    state = next;
    for (const listener of listeners) listener();
}

export function useBlockUIState(): BlockUIState {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
