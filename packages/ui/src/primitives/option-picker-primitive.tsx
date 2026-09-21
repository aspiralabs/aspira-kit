'use client';

import * as React from 'react';

import { cn } from '../lib/cn.js';
import { Icon } from '../components/icon/index.js';
import { useDebounce } from '../lib/use-debounce.js';
import { PaginatedResponse } from '../lib/types.js';
import {
    CheckboxPrimitive,
    CheckboxIndicatorPrimitive,
} from './checkbox-primitive.js';

/**
 * `OptionPickerPrimitive` is the leaf "select-an-option" UI used to compose
 * higher-level surfaces — `InputSelect`'s dropdown, the toolbar Filter
 * sub-menu, etc. It is intentionally outer-chrome agnostic: drop it inside a
 * Popover, a Radix DropdownMenu sub-content, or any floating panel. It owns:
 *   - the option pool (local list, local-with-search, or remote endpoint),
 *   - an optional header (label + Clear),
 *   - an optional search row,
 *   - a multi (checkbox per row) or single (click-to-pick) variant.
 *
 * It does NOT render a trigger or floating wrapper — those belong to the
 * composing component.
 */

// =============================================================================
// SHARED TYPES
// =============================================================================

type OptionValue = string | number | boolean;

interface SelectOption {
    label: string;
    value: OptionValue;
    /**
     * The raw source item this option came from — the remote row (`dataMode='remote'`)
     * or the option object itself (local). Passed to `entryRender` as `data` so a
     * caller can render a custom option (avatar + name + email, etc).
     */
    raw?: unknown;
}

type DataMode = 'local' | 'remote';

/**
 * Custom renderer for a single option row (the "entry slot"). Receives the
 * option's raw source `data` — the shape returned by the remote endpoint (or the
 * local option object). Rendered as a component so it may use hooks.
 *
 *   const CustomEntry = ({ data }) => <div>{data.name} · {data.email}</div>;
 *   <InputSelect entryRender={CustomEntry} … />
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the entry shape belongs to the consumer's option list
type EntryRenderComponent = React.ComponentType<{ data: any }>;

interface OptionDataConfig {
    /** Local-mode option list. Required for `dataMode='local'`. Ignored for `dataMode='remote'`. */
    options?: SelectOption[];
    /** Render a search input above the option list. */
    searchable?: boolean;
    /** `local` (default) filters `options` client-side. `remote` fetches from `baseEndpoint`. */
    dataMode?: DataMode;
    /** Endpoint used when `dataMode='remote'`. Receives `?q=&limit=` and must return `PaginatedResponse<T>`. */
    baseEndpoint?: string;
    /** Extra query params merged into every remote request when the search box is empty. */
    defaultParams?: Record<string, string>;
    /** Page size sent as `?limit=`. */
    limit?: number;
    /** Property to read the option label from on remote items. Default `'name'`. */
    labelKey?: string;
    /** Property to read the option value from on remote items. Default `'id'`. */
    valueKey?: string;
    /** Search debounce in ms. */
    debounceMs?: number;
    /** Custom option-row renderer. Receives `{ data }` — the raw source item. */
    entryRender?: EntryRenderComponent;
}

interface UseSelectOptionsResult {
    visibleOptions: SelectOption[];
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    isLoading: boolean;
    hasError: boolean;
}

// =============================================================================
// HOOK — owns the option list. Three branches, all returning the same shape:
//   1. local + non-searchable → pass-through of props.options
//   2. local + searchable     → client-side filter on props.options
//   3. remote                 → debounced fetch from baseEndpoint, ignores options
// =============================================================================

function useSelectOptions({
    options = [],
    searchable = false,
    dataMode = 'local',
    baseEndpoint,
    defaultParams,
    limit = 20,
    labelKey = 'name',
    valueKey = 'id',
    debounceMs = 300,
}: OptionDataConfig): UseSelectOptionsResult {
    const [searchQuery, setSearchQuery] = React.useState('');
    const [remoteOptions, setRemoteOptions] = React.useState<SelectOption[]>([]);
    const [isLoading, setIsLoading] = React.useState(false);
    const [hasError, setHasError] = React.useState(false);

    const debouncedSearch = useDebounce(searchQuery, debounceMs);

    const fetchRemote = React.useCallback(
        (query: string, signal: AbortSignal) => {
            if (!baseEndpoint) {
                return Promise.reject(
                    new Error('[OptionPicker] baseEndpoint required for dataMode="remote"'),
                );
            }
            const url = new URL(baseEndpoint, window.location.origin);
            url.searchParams.set('limit', String(limit));
            if (query.trim()) {
                url.searchParams.set('q', query.trim());
            } else if (defaultParams) {
                for (const [k, v] of Object.entries(defaultParams)) url.searchParams.set(k, v);
            }
            return fetch(url.pathname + url.search, { signal });
        },
        [baseEndpoint, limit, defaultParams],
    );

    React.useEffect(() => {
        if (dataMode !== 'remote') return;
        const controller = new AbortController();
        setIsLoading(true);
        setHasError(false);
        fetchRemote(debouncedSearch, controller.signal)
            .then((res) => res.json())
            .then((data: PaginatedResponse<Record<string, unknown>>) => {
                setRemoteOptions(
                    (data.data ?? []).map((it) => ({
                        label: String(it[labelKey] ?? ''),
                        value: it[valueKey] as OptionValue,
                        raw: it,
                    })),
                );
            })
            .catch((err) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                setRemoteOptions([]);
                setHasError(true);
            })
            .finally(() => setIsLoading(false));
        return () => controller.abort();
    }, [dataMode, debouncedSearch, fetchRemote, labelKey, valueKey]);

    const visibleOptions = React.useMemo(() => {
        if (dataMode === 'remote') return remoteOptions;
        if (!searchable || !searchQuery.trim()) return options;
        const q = searchQuery.trim().toLowerCase();
        return options.filter((o) => o.label.toLowerCase().includes(q));
    }, [dataMode, remoteOptions, options, searchable, searchQuery]);

    return { visibleOptions, searchQuery, setSearchQuery, isLoading, hasError };
}

// =============================================================================
// PUBLIC PRIMITIVE
// =============================================================================

interface BaseOptionPickerProps extends OptionDataConfig {
    /** Header label shown above the search input. Pass empty string to hide. */
    headerLabel?: string;
    /** Empty-state copy. */
    emptyMessage?: string;
    /** Error-state copy. */
    errorMessage?: string;
    size?: 'default' | 'sm' | 'xs';
    className?: string;
    /**
     * Optional "create from search" affordance. When set and the search box holds
     * text that doesn't exactly match a visible option, a create row is appended
     * that calls `onCreate` with the trimmed query — turning the picker into a
     * combobox (e.g. add a brand-new tag).
     */
    onCreate?: (query: string) => void;
    /** Label for the create row. Defaults to `Add "{query}"`. */
    createLabel?: (query: string) => React.ReactNode;
}

interface SingleOptionPickerProps extends BaseOptionPickerProps {
    multi?: false;
    value?: OptionValue;
    onValueChange?: (value: OptionValue | undefined) => void;
}

interface MultiOptionPickerProps extends BaseOptionPickerProps {
    multi: true;
    value?: OptionValue[];
    onValueChange?: (values: OptionValue[]) => void;
}

type OptionPickerProps = SingleOptionPickerProps | MultiOptionPickerProps;

function OptionPickerPrimitive(props: OptionPickerProps) {
    if (props.multi) return <OptionPickerMulti {...props} />;
    return <OptionPickerSingle {...props} />;
}

OptionPickerPrimitive.displayName = 'OptionPickerPrimitive';

// =============================================================================
// Internal — shared header, search row, and async-state renderer.
// =============================================================================

function PickerHeader({
    headerLabel,
    showClear,
    onClear,
}: {
    headerLabel?: string;
    showClear: boolean;
    onClear: () => void;
}) {
    if (!headerLabel) return null;
    return (
        <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
            <span className="text-sm font-medium text-foreground">{headerLabel}</span>
            {showClear && (
                <button
                    type="button"
                    onClick={onClear}
                    className="text-sm text-destructive hover:text-destructive/80 transition-colors cursor-pointer"
                >
                    Clear
                </button>
            )}
        </div>
    );
}

function PickerSearchRow({
    value,
    onChange,
    sizeClass,
}: {
    value: string;
    onChange: (v: string) => void;
    sizeClass: string;
}) {
    return (
        <div
            // Stop typeahead handlers in any parent menu (Radix DropdownMenu /
            // Select) from intercepting characters meant for this input.
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="flex items-center gap-2 px-3 h-10 min-h-10 shrink-0 border-b border-border bg-background"
        >
            <Icon icon="magnify-alt" size={16} className="text-foreground-subtext shrink-0" />
            <input
                type="text"
                placeholder="Search…"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    'flex-1 min-w-0 h-full bg-transparent leading-none outline-none placeholder:text-foreground-subtext',
                    sizeClass,
                )}
            />
        </div>
    );
}

// The option row's label: the caller's `entryRender` when given, else the plain label.
function OptionLabel({ option, entry: Entry }: { option: SelectOption; entry?: EntryRenderComponent }) {
    if (Entry) {
        return (
            <span className="flex-1 min-w-0">
                <Entry data={option.raw ?? option} />
            </span>
        );
    }
    return <span className="flex-1 truncate">{option.label}</span>;
}

function PickerStates({
    dataMode,
    isLoading,
    hasError,
    isEmpty,
    emptyMessage,
    errorMessage,
}: {
    dataMode: DataMode;
    isLoading: boolean;
    hasError: boolean;
    isEmpty: boolean;
    emptyMessage: string;
    errorMessage: string;
}) {
    if (dataMode === 'remote' && isLoading) {
        return (
            <div className="flex items-center justify-center py-4">
                <Icon
                    icon="progress_activity"
                    size={16}
                    className="animate-spin text-foreground-subtext"
                />
            </div>
        );
    }
    if (dataMode === 'remote' && hasError) {
        return (
            <p className="text-xs text-foreground-subtext text-center py-4">{errorMessage}</p>
        );
    }
    if (isEmpty) {
        return (
            <p className="text-xs text-foreground-subtext text-center py-4">{emptyMessage}</p>
        );
    }
    return null;
}

// =============================================================================
// Multi variant — checkbox per row, header carries a Clear affordance, the
// container stays open across toggles.
// =============================================================================

function OptionPickerMulti(props: MultiOptionPickerProps) {
    const {
        value = [],
        onValueChange,
        searchable = false,
        headerLabel = 'Select Values',
        dataMode = 'local',
        emptyMessage = 'No results found',
        errorMessage = 'Failed to load results',
        size = 'default',
        className,
        entryRender: Entry,
    } = props;

    const { visibleOptions, searchQuery, setSearchQuery, isLoading, hasError } =
        useSelectOptions(props);

    const itemSizeClass =
        size === 'default' ? 'text-base' : size === 'sm' ? 'text-sm' : 'text-xs';

    const toggle = (val: OptionValue) => {
        const has = value.some((v) => v === val);
        const next = has ? value.filter((v) => v !== val) : [...value, val];
        onValueChange?.(next);
    };

    const clear = () => onValueChange?.([]);

    return (
        <div className={cn('flex flex-col max-h-80 overflow-hidden', className)}>
            <PickerHeader
                headerLabel={headerLabel}
                showClear={value.length > 0}
                onClear={clear}
            />
            {searchable && (
                <PickerSearchRow
                    value={searchQuery}
                    onChange={setSearchQuery}
                    sizeClass={itemSizeClass}
                />
            )}
            <div className="flex-1 overflow-y-auto py-1">
                <PickerStates
                    dataMode={dataMode}
                    isLoading={isLoading}
                    hasError={hasError}
                    isEmpty={!isLoading && !hasError && visibleOptions.length === 0}
                    emptyMessage={emptyMessage}
                    errorMessage={errorMessage}
                />
                {!isLoading &&
                    !hasError &&
                    visibleOptions.map((opt) => {
                        const checked = value.some((v) => v === opt.value);
                        return (
                            <label
                                key={String(opt.value)}
                                className={cn(
                                    'flex items-center gap-3 px-3 py-2 cursor-pointer rounded-sm hover:bg-foreground/5',
                                    itemSizeClass,
                                )}
                            >
                                <CheckboxPrimitive
                                    checked={checked}
                                    onCheckedChange={() => toggle(opt.value)}
                                >
                                    <CheckboxIndicatorPrimitive>
                                        <Icon icon="check" size={12} />
                                    </CheckboxIndicatorPrimitive>
                                </CheckboxPrimitive>
                                <OptionLabel option={opt} entry={Entry} />
                            </label>
                        );
                    })}
            </div>
        </div>
    );
}

// =============================================================================
// Single variant — clicking a row sets the value. The composing component
// typically closes the floating container in response to onValueChange.
// =============================================================================

function OptionPickerSingle(props: SingleOptionPickerProps) {
    const {
        value,
        onValueChange,
        searchable = false,
        headerLabel = 'Select Value',
        dataMode = 'local',
        emptyMessage = 'No results found',
        errorMessage = 'Failed to load results',
        size = 'default',
        className,
        onCreate,
        createLabel,
        entryRender: Entry,
    } = props;

    const { visibleOptions, searchQuery, setSearchQuery, isLoading, hasError } =
        useSelectOptions(props);

    const itemSizeClass =
        size === 'default' ? 'text-base' : size === 'sm' ? 'text-sm' : 'text-xs';

    const clear = () => onValueChange?.(undefined);

    const trimmedQuery = searchQuery.trim();
    const showCreate =
        !!onCreate &&
        trimmedQuery.length > 0 &&
        !isLoading &&
        !hasError &&
        !visibleOptions.some((o) => o.label.toLowerCase() === trimmedQuery.toLowerCase());
    const createText = createLabel ? createLabel(trimmedQuery) : `Add “${trimmedQuery}”`;

    return (
        <div className={cn('flex flex-col max-h-80 overflow-hidden', className)}>
            <PickerHeader
                headerLabel={headerLabel}
                showClear={value !== undefined && value !== null && value !== ''}
                onClear={clear}
            />
            {searchable && (
                <PickerSearchRow
                    value={searchQuery}
                    onChange={setSearchQuery}
                    sizeClass={itemSizeClass}
                />
            )}
            <div className="flex-1 overflow-y-auto py-1">
                <PickerStates
                    dataMode={dataMode}
                    isLoading={isLoading}
                    hasError={hasError}
                    isEmpty={!isLoading && !hasError && visibleOptions.length === 0 && !showCreate}
                    emptyMessage={emptyMessage}
                    errorMessage={errorMessage}
                />
                {!isLoading &&
                    !hasError &&
                    visibleOptions.map((opt) => {
                        const selected = value === opt.value;
                        return (
                            <button
                                type="button"
                                key={String(opt.value)}
                                onClick={() => onValueChange?.(opt.value)}
                                className={cn(
                                    'flex w-full items-center gap-3 px-3 py-2 cursor-pointer rounded-sm hover:bg-foreground/5 text-left',
                                    itemSizeClass,
                                )}
                            >
                                <OptionLabel option={opt} entry={Entry} />
                                {selected && (
                                    <Icon
                                        icon="check"
                                        size={16}
                                        className="text-foreground shrink-0"
                                    />
                                )}
                            </button>
                        );
                    })}
                {showCreate && (
                    <button
                        type="button"
                        onClick={() => onCreate!(trimmedQuery)}
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 cursor-pointer rounded-sm hover:bg-foreground/5 text-left',
                            itemSizeClass,
                        )}
                    >
                        <Icon icon="add" size={16} className="shrink-0 text-foreground-subtext" />
                        <span className="flex-1 truncate">{createText}</span>
                    </button>
                )}
            </div>
        </div>
    );
}

export { OptionPickerPrimitive, useSelectOptions };
export type {
    OptionValue,
    SelectOption,
    DataMode,
    EntryRenderComponent,
    OptionDataConfig,
    OptionPickerProps,
    SingleOptionPickerProps,
    MultiOptionPickerProps,
};
