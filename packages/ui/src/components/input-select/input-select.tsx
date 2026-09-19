'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';
import { FormError } from '../form/index.js';
import { Icon } from '../icon/index.js';
import { Tooltip } from '../tooltip/index.js';
import {
    SelectPrimitive,
    SelectContentPrimitive,
    SelectItemPrimitive,
    SelectTriggerPrimitive,
    SelectValuePrimitive,
} from '../../primitives/select-primitive.js';
import {
    PopoverPrimitive,
    PopoverContentPrimitive,
    PopoverTriggerPrimitive,
} from '../../primitives/popover-primitive.js';
import {
    OptionPickerPrimitive,
    useSelectOptions,
    type OptionValue,
    type SelectOption,
    type DataMode,
    type EntryRenderComponent,
    type OptionDataConfig,
} from '../../primitives/option-picker-primitive.js';

interface BaseInputSelectProps extends OptionDataConfig {
    name?: string;
    label?: string;
    error?: FormError;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    triggerClassName?: string;
    size?: 'default' | 'sm' | 'xs';
    /**
     * Visual style of the trigger control.
     * - `'input'` (default): full-width input-shaped field with chevron + inline clear X.
     * - `'badge'`: compact pill with a double-arrow indicator; suited for quick-filter chips.
     *   Popover/search/option behavior is identical across both variants.
     */
    triggerVariant?: 'input' | 'badge';
    /** Label rendered above the search input. Defaults to `'Select Value'` (single) / `'Select Values'` (multi). */
    headerLabel?: string;
    /** Empty-state copy. */
    emptyMessage?: string;
    /** Error-state copy. */
    errorMessage?: string;
}

interface InputSelectSingleProps extends BaseInputSelectProps {
    multi?: false;
    value?: OptionValue;
    defaultValue?: OptionValue;
    /** Receives the picked option value, or `undefined` when the user clears via the inline X. */
    onValueChange?: (value: OptionValue | undefined) => void;
    // Form / react-hook-form compatibility — `<Form>` spreads `{ value, onChange }` from its Controller
    onChange?: (value: OptionValue | undefined) => void;
}

interface InputSelectMultiProps extends BaseInputSelectProps {
    multi: true;
    value?: OptionValue[];
    defaultValue?: OptionValue[];
    /** Receives the full array of selected values on every toggle. Empty array when fully cleared. */
    onValueChange?: (values: OptionValue[]) => void;
    // Form / react-hook-form compatibility
    onChange?: (values: OptionValue[]) => void;
}

type InputSelectProps = InputSelectSingleProps | InputSelectMultiProps;

// =============================================================================
// PUBLIC COMPONENT — branches on the `multi` discriminator. Single uses Radix
// Select for keyboard-driven selection; multi uses Popover + OptionPicker
// (since Radix Select cannot hold multiple values).
// =============================================================================

function InputSelect(props: InputSelectProps) {
    if (props.multi) {
        return <InputSelectMulti {...props} />;
    }
    return <InputSelectSingle {...props} />;
}

InputSelect.displayName = 'InputSelect';

// =============================================================================
// SINGLE MODE — Radix Select. Kept on RadixSelect (rather than re-using the
// OptionPicker primitive) so we keep keyboard navigation, typeahead, and the
// auto-close-on-pick behavior that makes single-select feel right.
// =============================================================================

function InputSelectSingle(props: InputSelectSingleProps) {
    const {
        name,
        label,
        error,
        placeholder,
        options = [],
        value,
        defaultValue,
        onValueChange,
        onChange,
        disabled,
        className,
        triggerClassName,
        size = 'default',
        triggerVariant = 'input',
        searchable = false,
        headerLabel = 'Select Value',
        dataMode = 'local',
        emptyMessage = 'No results found',
        errorMessage = 'Failed to load results',
        entryRender: Entry,
    } = props;
    const isBadge = triggerVariant === 'badge';

    const { visibleOptions, searchQuery, setSearchQuery, isLoading, hasError } =
        useSelectOptions(props);

    const controlledByParent = value !== undefined || onChange !== undefined;
    const [internalValue, setInternalValue] = React.useState<OptionValue | undefined>(defaultValue);
    const current: OptionValue | undefined = controlledByParent ? value : internalValue;

    // Last-selected label, so the trigger keeps showing the right text even when
    // the option pool no longer contains the selected item (e.g. user filtered
    // it out, or the remote page rolled past it).
    const [cachedLabel, setCachedLabel] = React.useState<string | null>(null);

    // Stringified-value → typed-value lookup. Build from both the static options
    // prop and the currently-visible pool so we can recover the original type
    // (number/boolean) across Radix's string-only value boundary.
    const valueMap = React.useMemo(() => {
        const map: Record<string, OptionValue> = {};
        for (const opt of options) map[String(opt.value)] = opt.value;
        for (const opt of visibleOptions) map[String(opt.value)] = opt.value;
        return map;
    }, [options, visibleOptions]);

    const handleValueChange = (stringValue: string) => {
        const matched = visibleOptions.find((o) => String(o.value) === stringValue);
        if (matched) setCachedLabel(matched.label);
        const next = valueMap[stringValue] !== undefined ? valueMap[stringValue] : stringValue;
        if (!controlledByParent) setInternalValue(next);
        onValueChange?.(next);
        onChange?.(next);
    };

    const handleClear = () => {
        setCachedLabel(null);
        if (!controlledByParent) setInternalValue(undefined);
        onValueChange?.(undefined);
        onChange?.(undefined);
    };

    const hasValue = current !== undefined && current !== null && current !== '';

    // Reset the search query whenever the dropdown closes so the next open
    // starts with a clean slate.
    const handleOpenChange = (open: boolean) => {
        if (!open) setSearchQuery('');
    };

    // If the selected value isn't currently rendered as a SelectItem (filtered
    // out by search, or rolled off a remote page), Radix's SelectValue can't
    // resolve the trigger label. Resolve a fallback {label, value} we'll mount
    // as a hidden item below so Radix's normal lookup mechanism still works.
    const hiddenSelectedItem = React.useMemo<SelectOption | null>(() => {
        if (current === undefined || current === null || current === '') return null;
        if (visibleOptions.some((o) => o.value === current)) return null;
        const fromOptions = options.find((o) => o.value === current);
        if (fromOptions) return fromOptions;
        if (cachedLabel) return { label: cachedLabel, value: current };
        return { label: String(current), value: current };
    }, [current, visibleOptions, options, cachedLabel]);

    const itemSizeClass =
        size === 'default' ? 'text-base' : size === 'sm' ? 'text-sm' : 'text-xs';

    return (
        <div
            data-slot="select"
            data-name={name}
            className={cn('relative flex flex-col flex-shrink-0', className)}
        >
            {(label || error) && (
                <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm text-foreground">{label}</label>
                    {error && <p className="text-xs text-destructive font-medium">{error.message}</p>}
                </div>
            )}

            <SelectPrimitive
                name={name}
                value={
                    current !== undefined && current !== null && current !== ''
                        ? String(current)
                        : undefined
                }
                onValueChange={handleValueChange}
                onOpenChange={handleOpenChange}
                disabled={disabled}
            >
                <div className="relative">
                    <SelectTriggerPrimitive
                        size={size}
                        className={cn(
                            isBadge
                                ? cn(
                                      // Override the primitive's input-shaped defaults with badge-style visuals.
                                      // Size selectors match the primitive's `data-[size=*]:` specificity so
                                      // tailwind-merge picks the badge sizes cleanly.
                                      'data-[size=default]:h-8 data-[size=default]:text-sm',
                                      'data-[size=sm]:h-7 data-[size=sm]:text-xs',
                                      'data-[size=xs]:h-6 data-[size=xs]:text-[10px]',
                                      'rounded-full border-transparent',
                                      'bg-[var(--badge-gray)] text-[var(--badge-gray-foreground)]',
                                      'font-medium font-mono whitespace-nowrap px-3 py-0',
                                      'hover:border-transparent hover:bg-[var(--badge-gray)]/80',
                                      'focus-visible:border-transparent',
                                      'transition-colors duration-200',
                                      'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                                      // Hide the primitive's built-in chevron — badge renders its own unfold_more.
                                      // `!hidden` (display:none !important) is required to beat the Icon
                                      // component's inline `display:inline-flex` style.
                                      '[&>:last-child]:!hidden',
                                      error && 'ring-2 ring-destructive ring-offset-1',
                                  )
                                : cn(
                                      'w-full border border-input rounded-md focus-visible:border-primary hover:border-primary transition-all duration-200',
                                      'bg-input-bg px-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                                      { 'border-destructive': error, 'focus-visible:border-destructive': error },
                                      // Hide the trigger's native chevron when a value is set — the X button below replaces it.
                                      hasValue && !disabled && '[&>:last-child]:invisible',
                                  ),
                            triggerClassName,
                        )}
                    >
                        {/* Radix's SelectValue retains its last-rendered label across a
                            controlled → undefined transition (it can't actively clear
                            its own internal state). When we have no value, render the
                            placeholder ourselves so the X button visibly clears the
                            trigger. */}
                        {isBadge ? (
                            <span className="flex items-center gap-1.5 min-w-0">
                                {hasValue ? (
                                    <SelectValuePrimitive placeholder={placeholder} />
                                ) : (
                                    <span className="text-muted-foreground truncate">{placeholder}</span>
                                )}
                                <Icon
                                    icon="unfold_more"
                                    size={16}
                                    weight={700}
                                    className="opacity-70 shrink-0"
                                />
                            </span>
                        ) : hasValue ? (
                            <SelectValuePrimitive placeholder={placeholder} />
                        ) : (
                            <span className="text-muted-foreground">{placeholder}</span>
                        )}
                    </SelectTriggerPrimitive>
                    {!isBadge && hasValue && !disabled && (
                        <Tooltip text="Clear Value">
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleClear();
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                                aria-label="Clear value"
                                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 size-6 flex items-center justify-center text-foreground-subtext hover:text-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
                            >
                                <Icon icon="close" size={16} />
                            </button>
                        </Tooltip>
                    )}
                </div>
                <SelectContentPrimitive
                    className={cn(
                        // 12rem floor keeps labels readable when the trigger is narrower than the options.
                        'min-w-[12rem]',
                        isBadge
                            ? // Badge: let the popover grow to fit the longest option (no wrapping), capped so long labels don't run away.
                              'w-max max-w-[20rem]'
                            : // Input: keep matching trigger width — form fields lean on the alignment.
                              'w-[var(--radix-select-trigger-width)] [&_[data-radix-select-viewport]]:min-w-0',
                    )}
                    header={
                        searchable && (
                            <>
                                {/* Header label — sits in the white space above the
                                    search input. Defaults to "Select Value". */}
                                <div className="px-3 pt-3 pb-2 shrink-0">
                                    <span className="text-sm font-medium text-foreground">
                                        {headerLabel}
                                    </span>
                                </div>
                                <div
                                    // Stop Radix Select's typeahead + selection handling
                                    // from intercepting events that belong to the search
                                    // input. Without these, characters get eaten by
                                    // typeahead and pointerdowns collapse focus.
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    // Clamp the row tightly: explicit h-10 + shrink-0 +
                                    // min-h prevent the flex container from being grown by
                                    // the native input's intrinsic height (font + ua padding).
                                    className="flex items-center gap-2 px-3 h-10 min-h-10 shrink-0 border-b border-border bg-background"
                                >
                                    <Icon
                                        icon="magnify-alt"
                                        size={16}
                                        className="text-foreground-subtext shrink-0"
                                    />
                                    <input
                                        type="text"
                                        placeholder="Search…"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        // leading-none + h-full + min-w-0 keep the input
                                        // sized by its container, not its own font metrics.
                                        // itemSizeClass keeps the search text in lockstep
                                        // with the menu items (default → text-base, etc.).
                                        className={cn(
                                            'flex-1 min-w-0 h-full bg-transparent leading-none outline-none placeholder:text-foreground-subtext',
                                            itemSizeClass,
                                        )}
                                    />
                                </div>
                            </>
                        )
                    }
                >
                    {/* Hidden mount of the selected item when it isn't in the visible
                        pool — Radix indexes items by React context, so a display:none
                        item still feeds SelectValue's trigger-label lookup. */}
                    {hiddenSelectedItem && (
                        <SelectItemPrimitive
                            value={String(hiddenSelectedItem.value)}
                            className="hidden"
                        >
                            {hiddenSelectedItem.label}
                        </SelectItemPrimitive>
                    )}

                    {dataMode === 'remote' && isLoading && (
                        <div className="flex items-center justify-center py-4">
                            <Icon
                                icon="progress_activity"
                                size={16}
                                className="animate-spin text-foreground-subtext"
                            />
                        </div>
                    )}

                    {dataMode === 'remote' && !isLoading && hasError && (
                        <p className="text-xs text-foreground-subtext text-center py-4">
                            {errorMessage}
                        </p>
                    )}

                    {!isLoading && !hasError && visibleOptions.length === 0 && (
                        <p className="text-xs text-foreground-subtext text-center py-4">
                            {emptyMessage}
                        </p>
                    )}

                    {!isLoading &&
                        !hasError &&
                        visibleOptions.map((opt) => (
                            <SelectItemPrimitive
                                key={String(opt.value)}
                                value={String(opt.value)}
                                className={cn('rounded-sm', itemSizeClass)}
                            >
                                {Entry ? <Entry data={opt.raw ?? opt} /> : opt.label}
                            </SelectItemPrimitive>
                        ))}
                </SelectContentPrimitive>
            </SelectPrimitive>
        </div>
    );
}

// =============================================================================
// MULTI MODE — Popover trigger + OptionPickerPrimitive content. The picker
// owns the header/search/checkbox-list rendering; this component owns the
// trigger field, the selection summary, and the controlled-state plumbing.
// =============================================================================

function InputSelectMulti(props: InputSelectMultiProps) {
    const {
        name,
        label,
        error,
        placeholder,
        options = [],
        value,
        defaultValue,
        onValueChange,
        onChange,
        disabled,
        className,
        triggerClassName,
        size = 'default',
        triggerVariant = 'input',
        headerLabel = 'Select Values',
    } = props;
    const isBadge = triggerVariant === 'badge';

    const controlledByParent = value !== undefined || onChange !== undefined;
    const [internalValues, setInternalValues] = React.useState<OptionValue[]>(defaultValue ?? []);
    const current: OptionValue[] = controlledByParent ? (value ?? []) : internalValues;

    // Cache labels for in-session selections so the trigger keeps rendering
    // correctly even after the items roll off the visible pool (search filter,
    // remote page roll). Hydrated whenever we observe an option whose value is
    // currently selected.
    const [cachedLabels, setCachedLabels] = React.useState<Record<string, string>>({});
    const observeLabel = React.useCallback((opt: SelectOption) => {
        const k = String(opt.value);
        setCachedLabels((prev) => (prev[k] === opt.label ? prev : { ...prev, [k]: opt.label }));
    }, []);

    const labelMap = React.useMemo(() => {
        const map: Record<string, string> = { ...cachedLabels };
        for (const opt of options) map[String(opt.value)] = opt.label;
        return map;
    }, [options, cachedLabels]);

    const setValues = (next: OptionValue[]) => {
        if (!controlledByParent) setInternalValues(next);
        onValueChange?.(next);
        onChange?.(next);
    };

    const hasValue = current.length > 0;

    const triggerLabel = React.useMemo(() => {
        if (current.length === 0) return null;
        if (current.length === 1) {
            const k = String(current[0]);
            return labelMap[k] ?? k;
        }
        return `${current.length} selected`;
    }, [current, labelMap]);

    return (
        <div
            data-slot="select"
            data-name={name}
            className={cn('relative flex flex-col flex-shrink-0', className)}
        >
            {(label || error) && (
                <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm text-foreground">{label}</label>
                    {error && <p className="text-xs text-destructive font-medium">{error.message}</p>}
                </div>
            )}

            <PopoverPrimitive>
                <div className="relative">
                    <PopoverTriggerPrimitive asChild disabled={disabled}>
                        <button
                            type="button"
                            data-slot="select-trigger"
                            data-size={size}
                            className={cn(
                                isBadge
                                    ? cn(
                                          // Badge-style pill trigger. Sizes match the single-mode badge variant.
                                          'inline-flex w-fit items-center justify-between gap-1.5 whitespace-nowrap',
                                          'rounded-full border border-transparent bg-[var(--badge-gray)] text-[var(--badge-gray-foreground)]',
                                          'font-medium font-mono px-3 outline-none',
                                          'transition-colors duration-200 hover:bg-[var(--badge-gray)]/80',
                                          'data-[size=default]:h-8 data-[size=default]:text-sm',
                                          'data-[size=sm]:h-7 data-[size=sm]:text-xs',
                                          'data-[size=xs]:h-6 data-[size=xs]:text-[10px]',
                                          'disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50',
                                          error && 'ring-2 ring-destructive ring-offset-1',
                                      )
                                    : cn(
                                          // Match SelectTriggerPrimitive visuals so single and
                                          // multi triggers are visually interchangeable.
                                          'flex w-full items-center justify-between gap-2 whitespace-nowrap',
                                          'border border-input rounded-md bg-input-bg px-3 py-2 text-foreground outline-none',
                                          'transition-all duration-200 hover:border-primary focus-visible:border-primary',
                                          'data-[size=default]:h-[56px] data-[size=default]:text-base data-[size=sm]:h-10 data-[size=sm]:text-sm data-[size=xs]:h-8 data-[size=xs]:text-xs',
                                          'disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50',
                                          error && 'border-destructive focus-visible:border-destructive',
                                          hasValue && !disabled && '[&>:last-child]:invisible',
                                      ),
                                triggerClassName,
                            )}
                        >
                            <span
                                className={cn(
                                    'text-left truncate min-w-0',
                                    !isBadge && 'flex-1',
                                    !hasValue && 'text-muted-foreground',
                                )}
                            >
                                {hasValue ? triggerLabel : placeholder}
                            </span>
                            <Icon
                                icon={isBadge ? 'unfold_more' : 'keyboard_arrow_down'}
                                size={isBadge ? 16 : 20}
                                weight={isBadge ? 700 : 400}
                                className={cn('shrink-0', isBadge ? 'opacity-70' : 'opacity-50')}
                            />
                        </button>
                    </PopoverTriggerPrimitive>
                    {!isBadge && hasValue && !disabled && (
                        <Tooltip text="Clear Value">
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setCachedLabels({});
                                    setValues([]);
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                                aria-label="Clear values"
                                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 size-6 flex items-center justify-center text-foreground-subtext hover:text-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
                            >
                                <Icon icon="close" size={16} />
                            </button>
                        </Tooltip>
                    )}
                </div>

                <PopoverContentPrimitive
                    align="start"
                    sideOffset={4}
                    className={cn(
                        'p-0 min-w-[12rem]',
                        isBadge
                            ? 'w-max max-w-[20rem]'
                            : 'w-[var(--radix-popover-trigger-width)]',
                    )}
                >
                    <PickerLabelObserver
                        values={current}
                        options={options}
                        onObserve={observeLabel}
                    />
                    <OptionPickerPrimitive
                        {...(props as InputSelectMultiProps)}
                        multi
                        headerLabel={headerLabel}
                        value={current}
                        onValueChange={setValues}
                    />
                </PopoverContentPrimitive>
            </PopoverPrimitive>
        </div>
    );
}

/**
 * Renders nothing. Watches the local `options` prop for any entry that
 * matches a currently-selected value and forwards its label up so the
 * trigger keeps reading correctly even when the picker's internal pool
 * (remote results, search filter) doesn't include the selection. The picker
 * itself doesn't bubble label observations, so the parent has to peek.
 */
function PickerLabelObserver({
    values,
    options,
    onObserve,
}: {
    values: OptionValue[];
    options: SelectOption[];
    onObserve: (opt: SelectOption) => void;
}) {
    React.useEffect(() => {
        const selected = new Set(values.map((v) => String(v)));
        for (const opt of options) {
            if (selected.has(String(opt.value))) onObserve(opt);
        }
    }, [values, options, onObserve]);
    return null;
}

export { InputSelect };
export type {
    InputSelectProps,
    InputSelectSingleProps,
    InputSelectMultiProps,
    OptionValue,
    SelectOption,
    DataMode,
    EntryRenderComponent,
};
