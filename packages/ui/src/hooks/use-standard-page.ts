'use client';

import { MenuItem } from '../layout/index.js';
import { useSearchParams } from './use-search-params.js';
import { useEffect, useRef, useState } from 'react';

interface UseStandardPageOptions {
    /** When true, skip all URL read/write — use local state only */
    embedded?: boolean;
    /** Override the default initial tab (defaults to first menu item) */
    initialTab?: string;
}

export function useStandardPage<T extends string>(menuItems: readonly MenuItem[], options?: UseStandardPageOptions) {
    const { embedded = false, initialTab } = options ?? {};
    const searchParams = useSearchParams();
    const defaultTab = (initialTab ?? menuItems[0]?.paramKey ?? '') as T;
    const [activeTab, setActiveTab] = useState<T>(defaultTab);
    const isInitialMount = useRef(true);

    // Initialize active tab from URL on mount (skip when embedded)
    useEffect(() => {
        if (embedded) return;
        if (!isInitialMount.current) return;
        isInitialMount.current = false;

        const viewParam = searchParams.get('view');
        const validTabs = menuItems.map((item) => item.paramKey);

        if (viewParam && validTabs.includes(viewParam)) {
            setActiveTab(viewParam as T);
        } else {
            // If no valid view param, set to default tab and update URL
            setActiveTab(defaultTab);
            const url = new URL(window.location.href);
            url.searchParams.set('view', defaultTab);
            window.history.replaceState({}, '', url.toString());
        }
    }, [searchParams, menuItems, defaultTab, embedded]);

    const handleTabChange = (paramKey: string) => {
        setActiveTab(paramKey as T);
        if (!embedded) {
            const url = new URL(window.location.href);
            url.searchParams.set('view', paramKey);
            window.history.replaceState({}, '', url.toString());
        }
    };

    return {
        activeTab,
        handleTabChange,
    };
}
