import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFormAction } from './use-form-action.js';
import { useToolbarUrlState } from './use-toolbar-url-state.js';

describe('useFormAction', () => {
    it('tracks pending while the action runs and returns its result', async () => {
        let release!: (v: string) => void;
        const action = vi.fn(() => new Promise<string>((r) => (release = r)));
        const { result } = renderHook(() => useFormAction(action));

        let promise!: Promise<string>;
        act(() => {
            promise = result.current.action();
        });
        expect(result.current.isPending).toBe(true);

        await act(async () => {
            release('done');
            await expect(promise).resolves.toBe('done');
        });
        expect(result.current.isPending).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('captures the error and still rejects', async () => {
        const { result } = renderHook(() => useFormAction(() => Promise.reject(new Error('boom'))));

        await act(async () => {
            await expect(result.current.action()).rejects.toThrow('boom');
        });
        expect(result.current.error?.message).toBe('boom');
        expect(result.current.isPending).toBe(false);
    });
});

describe('useToolbarUrlState', () => {
    afterEach(() => {
        window.history.replaceState(null, '', '/');
        vi.useRealTimers();
    });

    it('hydrates filters, single values, and search from the URL', async () => {
        window.history.replaceState(null, '', '/list?role=A&role=B&view=grid&q=cat');
        const { result } = renderHook(() =>
            useToolbarUrlState({ filterKeys: ['role'], singleValueKeys: ['view'] }),
        );

        await waitFor(() => expect(result.current.search).toBe('cat'));
        expect(result.current.filterValues).toEqual({ role: ['A', 'B'] });
        expect(result.current.singleValues).toEqual({ view: 'grid' });
        expect(result.current.debouncedSearch).toBe('cat');
    });

    it('writes changes back with replaceState, debouncing search', async () => {
        window.history.replaceState(null, '', '/list?keep=1');
        vi.useFakeTimers();
        const { result } = renderHook(() => useToolbarUrlState({ filterKeys: ['role'], debounceMs: 300 }));

        act(() => {
            result.current.setFilterValues({ role: ['A'] });
            result.current.setSearch('  dog ');
        });
        expect(window.location.search).toBe('?keep=1&role=A');

        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(result.current.debouncedSearch).toBe('  dog ');
        expect(window.location.search).toBe('?keep=1&role=A&q=dog');
    });
});
