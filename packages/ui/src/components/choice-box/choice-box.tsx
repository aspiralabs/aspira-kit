'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from '../icon/index.js';
import { CheckboxPrimitive } from '../../primitives/checkbox-primitive.js';

export interface ChoiceBoxOption {
    title: string;
    description?: string;
    value: string;
    disabled?: boolean;
}

interface ChoiceBoxBaseProps {
    options: ChoiceBoxOption[];
    name?: string;
    className?: string;
    cardClassName?: string;
    disabled?: boolean;
    error?: unknown;
}

interface ChoiceBoxSingleProps extends ChoiceBoxBaseProps {
    mode?: 'single';
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    // Form / react-hook-form compatibility — the `<Form>` wrapper spreads `onChange` from its Controller
    onChange?: (value: string) => void;
}

interface ChoiceBoxMultiProps extends ChoiceBoxBaseProps {
    mode: 'multi';
    value?: string[];
    defaultValue?: string[];
    onValueChange?: (value: string[]) => void;
    onChange?: (value: string[]) => void;
}

export type ChoiceBoxProps = ChoiceBoxSingleProps | ChoiceBoxMultiProps;

type AnyValue = string | string[] | undefined;

function RadioIndicator({ selected }: { selected: boolean }) {
    const state = selected ? 'checked' : 'unchecked';
    return (
        <div
            data-slot="choice-box-radio-indicator"
            data-state={state}
            className={cn(
                'size-[18px] rounded-full border-2 flex items-center justify-center transition-colors',
                selected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
            )}
        >
            {selected && <div className="size-2 rounded-full bg-primary-foreground" />}
        </div>
    );
}

// Shared `CheckboxPrimitive` (same one `<Checkbox>` uses) so the visual stays in
// lockstep. The 18×18 slot wrapper keeps title columns aligned with the radio
// variant even though the primitive is natively 16×16 (size-4). Kept
// non-interactive (tabIndex=-1 + aria-hidden + pointer-events-none) so the outer
// card stays the sole click/focus target. The check icon is rendered as a direct
// child rather than via CheckboxIndicatorPrimitive because
// `@radix-ui/react-presence` (used by Indicator) loops its ref-attach effect when
// nested inside an RHF Controller that re-renders on every state change.
function CheckIndicator({ selected }: { selected: boolean }) {
    return (
        <CheckboxPrimitive
            checked={selected}
            tabIndex={-1}
            aria-hidden="true"
            data-slot="choice-box-checkbox-indicator"
            className="pointer-events-none"
        >
            {selected && <Icon icon="check" size={16} className="text-current" />}
        </CheckboxPrimitive>
    );
}

const INDICATORS = { single: RadioIndicator, multi: CheckIndicator } as const;

function ChoiceBox(props: ChoiceBoxProps) {
    const {
        mode = 'single',
        options,
        name,
        className,
        cardClassName,
        disabled,
        error,
        value,
        defaultValue,
        onValueChange,
        onChange,
    } = props as ChoiceBoxBaseProps & {
        mode?: 'single' | 'multi';
        value?: AnyValue;
        defaultValue?: AnyValue;
        onValueChange?: (value: AnyValue) => void;
        onChange?: (value: AnyValue) => void;
    };

    // Controlled when the parent binds `value` directly, or when Form/RHF is wiring us up
    // (its Controller spreads `onChange` through). `onValueChange` is only an observer —
    // callers may pass it alongside an uncontrolled component to watch selections.
    const controlledByParent = value !== undefined || onChange !== undefined;

    const [internalValue, setInternalValue] = React.useState<AnyValue>(() => {
        if (defaultValue !== undefined) return defaultValue;
        return mode === 'multi' ? [] : undefined;
    });

    const rawValue: AnyValue = controlledByParent ? value : internalValue;

    // Normalize against mode — guards against RHF delivering an undefined before hydration
    // (multi) or a stale array from a prior mode flip.
    const current: AnyValue =
        mode === 'multi'
            ? Array.isArray(rawValue)
                ? rawValue
                : []
            : typeof rawValue === 'string'
              ? rawValue
              : undefined;

    const fireChange = (next: AnyValue) => {
        if (!controlledByParent) setInternalValue(next);
        onValueChange?.(next as string & string[]);
        onChange?.(next as string & string[]);
    };

    const handleSelect = (optValue: string) => {
        if (mode === 'multi') {
            const arr = current as string[];
            const next = arr.includes(optValue)
                ? arr.filter((v) => v !== optValue)
                : [...arr, optValue];
            fireChange(next);
        } else {
            fireChange(optValue);
        }
    };

    const isSelected = (optValue: string): boolean => {
        if (mode === 'multi') {
            return (current as string[]).includes(optValue);
        }
        return current === optValue;
    };

    const groupRole = mode === 'single' ? 'radiogroup' : 'group';
    const optionRole = mode === 'single' ? 'radio' : 'checkbox';
    const Indicator = INDICATORS[mode];
    const invalid = error ? true : undefined;

    return (
        <div
            role={groupRole}
            data-slot="choice-box"
            data-mode={mode}
            data-name={name}
            aria-invalid={invalid}
            className={cn('grid gap-3', className)}
        >
            {options.map((option) => {
                const selected = isSelected(option.value);
                const optDisabled = disabled || option.disabled;

                const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
                    if (optDisabled) return;
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        handleSelect(option.value);
                    }
                };

                const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
                    if (optDisabled) return;
                    // When `checked` flips, Radix's CheckboxPrimitive re-dispatches a click on
                    // its hidden BubbleInput (a form-integration shim). That synthetic click
                    // bubbles up here and would re-fire handleSelect → infinite loop. BubbleInput
                    // carries aria-hidden, so filter any event that originated in an aria-hidden
                    // descendant.
                    const target = e.target as HTMLElement;
                    if (
                        target.getAttribute?.('aria-hidden') === 'true' ||
                        target.closest?.('[aria-hidden="true"]')
                    ) {
                        return;
                    }
                    handleSelect(option.value);
                };

                const tabIndex = optDisabled ? -1 : 0;
                const dataSelected = selected ? '' : undefined;
                const dataDisabled = optDisabled ? '' : undefined;

                return (
                    <div
                        key={option.value}
                        role={optionRole}
                        aria-checked={selected}
                        aria-disabled={optDisabled || undefined}
                        tabIndex={tabIndex}
                        data-slot="choice-box-card"
                        data-value={option.value}
                        data-selected={dataSelected}
                        data-disabled={dataDisabled}
                        onClick={handleClick}
                        onKeyDown={handleKey}
                        className={cn(
                            // Border effect lives entirely on an inset ring so the active/hover
                            // state grows *inward*. With an outward border + outer ring the
                            // edges get clipped when this component sits inside an
                            // overflow-hidden parent (drawers, modals, anything edge-to-edge).
                            'text-left py-6 px-5 rounded-lg ring-1 ring-inset transition-all duration-200 flex gap-3',
                            // Focus indicator uses outline (can grow outward safely — the
                            // browser draws it on top of any clipping ancestor).
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid',
                            optDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                            selected
                                ? 'ring-[1.5px] ring-primary bg-primary/5'
                                : 'ring-border hover:ring-[1.5px] hover:ring-primary',
                            error ? 'ring-[1.5px] ring-destructive' : undefined,
                            cardClassName,
                        )}
                    >
                        {/*
                         * Indicator slot is a fixed 18×18 box so the title column starts at the
                         * same X regardless of mode. Both indicators are sized identically.
                         */}
                        <div
                            className="mt-[3px] shrink-0 size-[18px] flex items-center justify-center"
                            data-slot="choice-box-indicator-slot"
                        >
                            <Indicator selected={selected} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <span className="text-base font-semibold text-foreground">
                                {option.title}
                            </span>
                            {option.description && (
                                <p className="text-sm text-foreground-subtext mt-1">
                                    {option.description}
                                </p>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

ChoiceBox.displayName = 'ChoiceBox';

export { ChoiceBox };
