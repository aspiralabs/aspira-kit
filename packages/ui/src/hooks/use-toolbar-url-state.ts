'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// URL-synced state for StandardToolbar: repeatable keys for multi-value filters
// (?role=A&role=B), single keys for one-value toggles, and a debounced search
// param. Reads the URL once on mount, then writes with replaceState, so it never
// triggers a router navigation.

export interface UseToolbarUrlStateConfig {
    filterKeys: string[];
    singleValueKeys?: string[];
    searchKey?: string;
    debounceMs?: number;
}

export interface UseToolbarUrlStateReturn {
    filterValues: Record<string, string[]>;
    setFilterValues: (values: Record<string, string[]>) => void;
    singleValues: Record<string, string | null>;
    setSingleValue: (key: string, value: string | null) => void;
    search: string;
    setSearch: (value: string) => void;
    debouncedSearch: string;
}

export function useToolbarUrlState({
    filterKeys,
    singleValueKeys = [],
    searchKey = 'q',
    debounceMs = 300,
}: UseToolbarUrlStateConfig): UseToolbarUrlStateReturn {
    const filterKeysRef = useRef(filterKeys);
    filterKeysRef.current = filterKeys;

    const singleKeysRef = useRef(singleValueKeys);
    singleKeysRef.current = singleValueKeys;

    const searchKeyRef = useRef(searchKey);
    searchKeyRef.current = searchKey;

    const [filterValues, setFilterValues] = useState<Record<string, string[]>>({});
    const [singleValues, setSingleValuesState] = useState<Record<string, string | null>>({});
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);

        const initialFilters: Record<string, string[]> = {};
        for (const key of filterKeysRef.current) {
            const values = params.getAll(key);
            if (values.length > 0) initialFilters[key] = values;
        }

        const initialSingles: Record<string, string | null> = {};
        for (const key of singleKeysRef.current) {
            const v = params.get(key);
            initialSingles[key] = v && v.length > 0 ? v : null;
        }

        const initialSearch = params.get(searchKeyRef.current) ?? '';

        setFilterValues(initialFilters);
        setSingleValuesState(initialSingles);
        setSearch(initialSearch);
        setDebouncedSearch(initialSearch);
        setHydrated(true);
    }, []);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search), debounceMs);
        return () => clearTimeout(t);
    }, [search, debounceMs]);

    useEffect(() => {
        if (!hydrated) return;
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);

        for (const key of filterKeysRef.current) params.delete(key);
        for (const key of singleKeysRef.current) params.delete(key);
        params.delete(searchKeyRef.current);

        for (const key of filterKeysRef.current) {
            for (const v of filterValues[key] ?? []) params.append(key, v);
        }
        for (const key of singleKeysRef.current) {
            const v = singleValues[key];
            if (v && v.length > 0) params.set(key, v);
        }
        const trimmed = debouncedSearch.trim();
        if (trimmed) params.set(searchKeyRef.current, trimmed);

        const query = params.toString();
        const newUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
        window.history.replaceState(null, '', newUrl);
    }, [filterValues, singleValues, debouncedSearch, hydrated]);

    const setSingleValue = useCallback((key: string, value: string | null) => {
        setSingleValuesState((prev) => ({ ...prev, [key]: value && value.length > 0 ? value : null }));
    }, []);

    return {
        filterValues,
        setFilterValues,
        singleValues,
        setSingleValue,
        search,
        setSearch,
        debouncedSearch,
    };
}
