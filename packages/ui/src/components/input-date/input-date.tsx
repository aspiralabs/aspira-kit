'use client';

import * as React from 'react';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import type { FactoryOpts } from 'imask';

import { cn } from '../../lib/cn.js';
import { Input } from '../input/index.js';
import { Icon } from '../icon/index.js';
import { Calendar } from '../calendar/index.js';
import { FormError } from '../form/index.js';
import {
    PopoverPrimitive,
    PopoverTriggerPrimitive,
    PopoverContentPrimitive,
} from '../../primitives/popover-primitive.js';

dayjs.extend(customParseFormat);

const DEFAULT_FORMAT = 'MM/DD/YYYY';
const DATE_MASK: FactoryOpts = { mask: '00/00/0000' };

interface InputDateProps {
    name?: string;
    label?: string;
    placeholder?: string;
    /** Canonical value — a JS `Date` or undefined. */
    value?: Date;
    defaultValue?: Date;
    onValueChange?: (value: Date | undefined) => void;
    /** Form / react-hook-form compatibility — `<Form>` spreads `{ onChange, value }`. */
    onChange?: (value: Date | undefined) => void;
    disabled?: boolean;
    error?: FormError;
    /** Oldest allowed date (inclusive). Defaults to 1900-01-01. */
    fromDate?: Date;
    /** Newest allowed date (inclusive). Defaults to 2100-12-31. */
    toDate?: Date;
    /** dayjs format string for the input display and parsing. Default: `MM/DD/YYYY`. */
    format?: string;
    size?: 'default' | 'sm' | 'xs';
    className?: string;
}

function toDisplayString(date: Date | undefined, format: string): string {
    if (!date) return '';
    const d = dayjs(date);
    return d.isValid() ? d.format(format) : '';
}

function parseDisplayString(str: string, format: string): Date | undefined {
    if (!str) return undefined;
    const d = dayjs(str, format, true);
    return d.isValid() ? d.toDate() : undefined;
}

function isWithinBounds(date: Date, fromDate: Date, toDate: Date): boolean {
    const t = date.getTime();
    return t >= fromDate.getTime() && t <= toDate.getTime();
}

function InputDate({
    name,
    label,
    placeholder,
    value,
    defaultValue,
    onValueChange,
    onChange,
    disabled,
    error,
    fromDate = new Date(1900, 0, 1),
    toDate = new Date(2100, 11, 31),
    format = DEFAULT_FORMAT,
    size = 'default',
    className,
}: InputDateProps) {
    // Controlled when parent binds `value` directly, or when Form/RHF wires `onChange` through.
    const controlledByParent = value !== undefined || onChange !== undefined;

    const [internalDate, setInternalDate] = React.useState<Date | undefined>(defaultValue);
    const currentDate: Date | undefined = controlledByParent ? value : internalDate;

    // Keep an internal input string so the user can type freely (including intermediate
    // invalid states). We re-sync it whenever the canonical date changes from the outside.
    const [displayValue, setDisplayValue] = React.useState<string>(() =>
        toDisplayString(currentDate, format),
    );
    const lastEmittedRef = React.useRef<string>(toDisplayString(currentDate, format));

    // Guards the initial empty-string fire that the underlying Input + imask emits on
    // mount (before its `defaultValue` effect has pushed our canonical value into imask).
    // Without this guard, a Form-controlled InputDate would emit `undefined` back to RHF
    // on mount, RHF would re-render, and the cycle would repeat → render loop.
    const mountedRef = React.useRef(false);
    React.useEffect(() => {
        mountedRef.current = true;
    }, []);

    React.useEffect(() => {
        const canonical = toDisplayString(currentDate, format);
        if (canonical !== lastEmittedRef.current) {
            lastEmittedRef.current = canonical;
            setDisplayValue(canonical);
        }
    }, [currentDate, format]);

    // Out-of-range check for typed dates. Paints the input error (the caller's `error`
    // takes precedence, since Form wires it via RHF).
    const [rangeError, setRangeError] = React.useState<FormError | undefined>(undefined);

    const [open, setOpen] = React.useState(false);
    const [viewMonth, setViewMonth] = React.useState<Date>(
        () => currentDate ?? new Date(),
    );

    const fireChange = (next: Date | undefined) => {
        if (!controlledByParent) setInternalDate(next);
        onValueChange?.(next);
        onChange?.(next);
    };

    const handleInputChange = ({ value: nextString }: { value: string; typedValue: unknown }) => {
        setDisplayValue(nextString);

        const trimmed = nextString?.trim() ?? '';

        // Input fires an initial empty onValueChange on mount — ignore it so we don't
        // clobber an externally-provided Date before imask has been hydrated.
        if (!mountedRef.current && !trimmed && lastEmittedRef.current !== '') {
            return;
        }

        if (!trimmed) {
            setRangeError(undefined);
            if (lastEmittedRef.current !== '') {
                lastEmittedRef.current = '';
                fireChange(undefined);
            }
            return;
        }

        // Only emit once the string parses to a full valid date in the expected format.
        const parsed = parseDisplayString(trimmed, format);
        if (!parsed) {
            // Still typing / invalid — don't emit yet, and don't set a range error.
            setRangeError(undefined);
            return;
        }

        if (!isWithinBounds(parsed, fromDate, toDate)) {
            setRangeError({
                type: 'range',
                message: `Date must be between ${dayjs(fromDate).format(format)} and ${dayjs(toDate).format(format)}`,
                ref: null as unknown as FormError['ref'],
            });
            return;
        }

        setRangeError(undefined);
        const formatted = toDisplayString(parsed, format);
        // Dedupe: don't re-fire when the canonical value matches what we already emitted
        // (e.g. imask echoes our own externally-driven value back to us on sync).
        if (lastEmittedRef.current !== formatted) {
            lastEmittedRef.current = formatted;
            fireChange(parsed);
        }
    };

    const handleCalendarSelect = (date: Date | undefined) => {
        if (!date) {
            lastEmittedRef.current = '';
            setDisplayValue('');
            setRangeError(undefined);
            fireChange(undefined);
            setOpen(false);
            return;
        }
        const nextString = toDisplayString(date, format);
        lastEmittedRef.current = nextString;
        setDisplayValue(nextString);
        setRangeError(undefined);
        setViewMonth(date);
        fireChange(date);
        setOpen(false);
    };

    const handleOpenChange = (next: boolean) => {
        if (next && currentDate) {
            // When opening, jump the calendar to the currently-selected month.
            setViewMonth(currentDate);
        }
        setOpen(next);
    };

    const effectiveError: FormError | undefined = error ?? rangeError;

    return (
        <div className={cn('relative w-full', className)} data-slot="input-date">
            <Input
                name={name}
                label={label}
                placeholder={placeholder ?? format}
                // Input is imask-backed; `defaultValue` is the contract it uses to re-sync its
                // internal mask state when the string changes externally. Passing `value` fights
                // with imask's own input management.
                defaultValue={displayValue}
                mask={DATE_MASK}
                onValueChange={handleInputChange}
                disabled={disabled}
                error={effectiveError}
                size={size}
                // Reserve space for the calendar icon button inside the input's padding.
                className="pr-11"
            />

            <PopoverPrimitive open={open} onOpenChange={handleOpenChange}>
                <PopoverTriggerPrimitive asChild>
                    <button
                        type="button"
                        disabled={disabled}
                        aria-label="Open calendar"
                        data-slot="input-date-trigger"
                        className={cn(
                            'absolute right-1.5 size-8 rounded-md flex items-center justify-center text-foreground-subtext cursor-pointer hover:bg-background hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            // Align the button vertically against the input's label-aware layout.
                            label ? 'top-[calc(50%+0.75rem)] -translate-y-1/2' : 'top-1/2 -translate-y-1/2',
                        )}
                    >
                        <Icon icon="calendar_today" size={18} />
                    </button>
                </PopoverTriggerPrimitive>
                <PopoverContentPrimitive
                    align="end"
                    sideOffset={6}
                    // Override the popover's default `w-72 p-4` for the calendar layout.
                    className="w-auto p-0"
                >
                    <Calendar
                        mode="single"
                        selected={currentDate}
                        month={viewMonth}
                        onMonthChange={setViewMonth}
                        onSelect={handleCalendarSelect}
                        disabled={[{ before: fromDate }, { after: toDate }]}
                        captionLayout="dropdown"
                        startMonth={fromDate}
                        endMonth={toDate}
                    />
                </PopoverContentPrimitive>
            </PopoverPrimitive>
        </div>
    );
}

InputDate.displayName = 'InputDate';

export { InputDate };
export type { InputDateProps };
