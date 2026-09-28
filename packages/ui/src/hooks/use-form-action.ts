'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useState } from 'react';

// Wraps an async action (server action, fetch, mutation) with pending and error
// state. The wrapped action keeps the original signature and still rejects, so
// callers can await it and handle the failure themselves.

type AsyncFunction = (...args: any[]) => Promise<any>;

export interface FormActionResult<T extends AsyncFunction> {
    action: T;
    isPending: boolean;
    error: Error | null;
}

export function useFormAction<T extends AsyncFunction>(action: T): FormActionResult<T> {
    const [isPending, setIsPending] = useState<boolean>(false);
    const [error, setError] = useState<Error | null>(null);

    const wrappedAction = useCallback(
        async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
            setIsPending(true);
            setError(null);

            try {
                return await action(...args);
            } catch (err) {
                setError(err instanceof Error ? err : new Error('An unknown error occurred'));
                throw err;
            } finally {
                setIsPending(false);
            }
        },
        [action],
    ) as T;

    return {
        action: wrappedAction,
        isPending,
        error,
    };
}
