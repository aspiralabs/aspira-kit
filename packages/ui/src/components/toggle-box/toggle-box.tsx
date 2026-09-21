'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';
import {
    SwitchPrimitive,
    SwitchThumbPrimitive,
} from '../../primitives/switch-primitive.js';

export interface ToggleBoxProps {
    title: React.ReactNode;
    description?: React.ReactNode;
    name?: string;
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    // Form / react-hook-form compatibility — `<Form>` spreads `{ onChange, value }` from its Controller
    value?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    error?: unknown;
    className?: string;
}

function ToggleBox({
    title,
    description,
    name,
    checked,
    defaultChecked,
    onCheckedChange,
    value,
    onChange,
    disabled,
    error,
    className,
}: ToggleBoxProps) {
    // Explicit `checked` > RHF-controlled (onChange wired) > plain boolean `value` > uncontrolled.
    const resolvedCheckedProp: boolean | undefined =
        typeof checked === 'boolean'
            ? checked
            : onChange !== undefined
              ? Boolean(value)
              : typeof value === 'boolean'
                ? value
                : undefined;

    // Track uncontrolled state so the card can visually reflect the toggle even when the
    // caller isn't controlling `checked` directly.
    const [internalChecked, setInternalChecked] = React.useState<boolean>(() =>
        defaultChecked ?? false,
    );

    const isControlled = resolvedCheckedProp !== undefined;
    const selected = isControlled ? resolvedCheckedProp : internalChecked;

    const fireChange = (next: boolean) => {
        if (!isControlled) setInternalChecked(next);
        onCheckedChange?.(next);
        onChange?.(next);
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        // Radix Switch renders a hidden BubbleInput that re-dispatches a click when `checked`
        // flips — that synthetic click bubbles up through this card and would toggle again,
        // causing an infinite ping-pong. BubbleInput is aria-hidden, so filter any event that
        // originated in an aria-hidden descendant. (Same pattern as ChoiceBox.)
        const target = e.target as HTMLElement;
        if (
            target.getAttribute?.('aria-hidden') === 'true' ||
            target.closest?.('[aria-hidden="true"]')
        ) {
            return;
        }
        fireChange(!selected);
    };

    const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            fireChange(!selected);
        }
    };

    const tabIndex = disabled ? -1 : 0;
    const dataSelected = selected ? '' : undefined;
    const dataDisabled = disabled ? '' : undefined;

    return (
        <div
            role="switch"
            aria-checked={selected}
            aria-disabled={disabled || undefined}
            tabIndex={tabIndex}
            data-slot="toggle-box"
            data-selected={dataSelected}
            data-disabled={dataDisabled}
            onClick={handleClick}
            onKeyDown={handleKey}
            className={cn(
                'text-left py-6 px-5 rounded-lg border transition-all duration-200 flex items-center gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary',
                error ? 'border-destructive' : undefined,
                className,
            )}
        >
            <div className="flex-1 min-w-0">
                <span className="text-base font-semibold text-foreground">{title}</span>
                {description && (
                    <p className="text-sm text-foreground-subtext mt-1">{description}</p>
                )}
            </div>
            {/*
             * Shared SwitchPrimitive (same one `<Switch>` uses). Kept non-interactive so the
             * outer card stays the single click/focus target; the BubbleInput re-dispatch loop
             * is handled by the aria-hidden filter in handleClick above.
             */}
            <SwitchPrimitive
                name={name}
                checked={selected}
                disabled={disabled}
                tabIndex={-1}
                aria-hidden="true"
                data-slot="toggle-box-switch"
                className="pointer-events-none shrink-0"
            >
                <SwitchThumbPrimitive />
            </SwitchPrimitive>
        </div>
    );
}

ToggleBox.displayName = 'ToggleBox';

export { ToggleBox };
