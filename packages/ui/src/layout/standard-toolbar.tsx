'use client';

import { Badge } from '../components/badge/index.js';
import {
    DropdownMenuPrimitive,
    DropdownMenuContentPrimitive,
    DropdownMenuItemPrimitive,
    DropdownMenuSubPrimitive,
    DropdownMenuSubContentPrimitive,
    DropdownMenuSubTriggerPrimitive,
    DropdownMenuTriggerPrimitive,
} from '../primitives/dropdown-menu-primitive.js';
import {
    OptionPickerPrimitive,
    type OptionDataConfig,
    type OptionValue,
} from '../primitives/option-picker-primitive.js';
import { Input } from '../components/input/index.js';
import { Icon } from '../components/icon/index.js';
import { Skeleton } from '../components/skeleton/index.js';
import { cn } from '../lib/cn.js';
import { ReactNode } from 'react';

export interface ToolbarFilterOption {
    value: string;
    label: string;
}

/**
 * One filter dimension in the toolbar's Filter dropdown. Each dimension
 * renders as a sub-menu trigger that, when expanded, shows an
 * `OptionPickerPrimitive` configured by the dimension's flags
 * (multi/searchable/local-or-remote).
 */
export interface ToolbarFilterDimension extends OptionDataConfig {
    key: string;
    label: string;
    /** Local options. Required for `dataMode='local'` (default), ignored for `dataMode='remote'`. */
    options?: ToolbarFilterOption[];
    /** Multi-select (default). Set false for single-select dimensions. */
    multi?: boolean;
    /**
     * Used to label active chips when the selected value isn't present in
     * `options` — the typical case for `dataMode='remote'` dimensions where
     * the option list is paged/searchable. Falls back to the raw value when
     * not provided.
     */
    getOptionLabel?: (value: string) => string | undefined;
}

interface StandardToolbarProps {
    filters?: ToolbarFilterDimension[];
    filterValues?: Record<string, string[]>;
    onFilterChange?: (values: Record<string, string[]>) => void;
    search?: string;
    onSearchChange?: (value: string) => void;
    searchPlaceholder?: string;
    leftSlot?: ReactNode;
    trailingSlot?: ReactNode;
    rightSlot?: ReactNode;
    className?: string;
}

export function StandardToolbar({
    filters = [],
    filterValues = {},
    onFilterChange,
    search,
    onSearchChange,
    searchPlaceholder = 'Search...',
    leftSlot,
    trailingSlot,
    rightSlot,
    className,
}: StandardToolbarProps) {
    const activeCount = Object.values(filterValues).reduce((acc, arr) => acc + arr.length, 0);
    const hasFilters = filters.length > 0;
    const hasSearch = onSearchChange !== undefined;

    const clearAll = () => onFilterChange?.({});

    const setDimensionValues = (key: string, next: string[]) => {
        onFilterChange?.({ ...filterValues, [key]: next });
    };

    const removeChip = (key: string, value: string) => {
        const current = filterValues[key] ?? [];
        onFilterChange?.({ ...filterValues, [key]: current.filter((v) => v !== value) });
    };

    const lookupLabel = (dim: ToolbarFilterDimension, value: string): string | undefined => {
        const fromOptions = dim.options?.find((o) => o.value === value)?.label;
        if (fromOptions) return fromOptions;
        const fromGetter = dim.getOptionLabel?.(value);
        if (fromGetter) return fromGetter;
        // When a dimension defines getOptionLabel, undefined means the label
        // hasn't hydrated yet — caller should render a skeleton instead of the
        // raw value (typically an opaque ID).
        if (dim.getOptionLabel) return undefined;
        return value;
    };

    const activeBadges: { key: string; value: string; label: string | undefined }[] = [];
    for (const dim of filters) {
        for (const val of filterValues[dim.key] ?? []) {
            activeBadges.push({ key: dim.key, value: val, label: lookupLabel(dim, val) });
        }
    }

    return (
        <div
            className={cn(
                'hidden sm:flex items-center justify-between gap-4 px-8 h-18 bg-background',
                className,
            )}
        >
            <div className="flex items-center gap-2 flex-wrap">
                {leftSlot}
                {hasFilters && (
                    <DropdownMenuPrimitive>
                        <DropdownMenuTriggerPrimitive asChild>
                            <Badge
                                asChild
                                size="xl"
                                variant="outline"
                                className={cn(
                                    'cursor-pointer',
                                    activeCount > 0
                                        ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
                                        : 'hover:bg-surface',
                                )}
                            >
                                <button type="button">
                                    <Icon icon="filter_list" size={16} />
                                    <span>Filter</span>
                                    {activeCount > 0 && (
                                        <span className="flex items-center justify-center bg-background text-foreground text-[10px] font-bold size-4 leading-none">
                                            {activeCount}
                                        </span>
                                    )}
                                </button>
                            </Badge>
                        </DropdownMenuTriggerPrimitive>
                        <DropdownMenuContentPrimitive align="start" className="min-w-52">
                            {filters.map((dim) => {
                                const current = filterValues[dim.key] ?? [];
                                const dimCount = current.length;
                                const multi = dim.multi ?? true;
                                return (
                                    <DropdownMenuSubPrimitive key={dim.key}>
                                        <DropdownMenuSubTriggerPrimitive>
                                            {dim.label}
                                            {dimCount > 0 && (
                                                <span className="text-muted-foreground ml-1">
                                                    ({dimCount})
                                                </span>
                                            )}
                                        </DropdownMenuSubTriggerPrimitive>
                                        <DropdownMenuSubContentPrimitive className="p-0 w-64">
                                            {multi ? (
                                                <OptionPickerPrimitive
                                                    multi
                                                    headerLabel={dim.label}
                                                    options={dim.options}
                                                    searchable={dim.searchable}
                                                    dataMode={dim.dataMode}
                                                    baseEndpoint={dim.baseEndpoint}
                                                    defaultParams={dim.defaultParams}
                                                    limit={dim.limit}
                                                    labelKey={dim.labelKey}
                                                    valueKey={dim.valueKey}
                                                    debounceMs={dim.debounceMs}
                                                    value={current}
                                                    onValueChange={(vals) =>
                                                        setDimensionValues(
                                                            dim.key,
                                                            (vals as OptionValue[]).map(String),
                                                        )
                                                    }
                                                />
                                            ) : (
                                                <OptionPickerPrimitive
                                                    headerLabel={dim.label}
                                                    options={dim.options}
                                                    searchable={dim.searchable}
                                                    dataMode={dim.dataMode}
                                                    baseEndpoint={dim.baseEndpoint}
                                                    defaultParams={dim.defaultParams}
                                                    limit={dim.limit}
                                                    labelKey={dim.labelKey}
                                                    valueKey={dim.valueKey}
                                                    debounceMs={dim.debounceMs}
                                                    value={current[0]}
                                                    onValueChange={(val) =>
                                                        setDimensionValues(
                                                            dim.key,
                                                            val === undefined ? [] : [String(val)],
                                                        )
                                                    }
                                                />
                                            )}
                                        </DropdownMenuSubContentPrimitive>
                                    </DropdownMenuSubPrimitive>
                                );
                            })}
                            {activeCount > 0 && (
                                <DropdownMenuItemPrimitive
                                    onClick={clearAll}
                                    className="text-destructive"
                                >
                                    Clear all
                                </DropdownMenuItemPrimitive>
                            )}
                        </DropdownMenuContentPrimitive>
                    </DropdownMenuPrimitive>
                )}

                {activeBadges.map((badge) => (
                    <Badge key={`${badge.key}-${badge.value}`} size="xl">
                        {badge.label !== undefined ? (
                            <>
                                {badge.label}
                                <button
                                    onClick={() => removeChip(badge.key, badge.value)}
                                    className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    <Icon icon="close" size={16} />
                                </button>
                            </>
                        ) : (
                            <Skeleton className="h-3.5 w-20" />
                        )}
                    </Badge>
                ))}

                {activeCount > 0 && (
                    <button
                        onClick={clearAll}
                        className="text-sm text-muted-foreground hover:text-foreground"
                    >
                        Clear
                    </button>
                )}

                {trailingSlot}
            </div>

            <div className="flex items-center gap-3">
                {rightSlot}
                {hasSearch && (
                    <Input
                        size="sm"
                        icon="magnify-alt"
                        placeholder={searchPlaceholder}
                        value={search ?? ''}
                        onValueChange={({ value }) => onSearchChange?.(value)}
                        className="w-72"
                    />
                )}
            </div>
        </div>
    );
}
