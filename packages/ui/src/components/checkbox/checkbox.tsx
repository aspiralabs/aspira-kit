'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from '../icon/index.js';
import {
    CheckboxPrimitive,
    CheckboxIndicatorPrimitive,
} from '../../primitives/checkbox-primitive.js';

export interface CheckboxProps
    extends Omit<
        React.ComponentPropsWithoutRef<typeof CheckboxPrimitive>,
        'onChange' | 'value' | 'checked' | 'defaultChecked' | 'onCheckedChange'
    > {
    label?: React.ReactNode;
    labelClassName?: string;
    wrapperClassName?: string;
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    // Form / react-hook-form compatibility. The `<Form>` wrapper spreads
    // `{ onChange, value }` from its Controller — we translate those into
    // Radix's `checked` / `onCheckedChange` semantics.
    value?: boolean;
    onChange?: (checked: boolean) => void;
    error?: unknown;
}

const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive>, CheckboxProps>(
    (
        {
            className,
            label,
            labelClassName,
            wrapperClassName,
            checked,
            value,
            defaultChecked,
            onCheckedChange,
            onChange,
            error,
            disabled,
            id,
            name,
            ...props
        },
        ref,
    ) => {
        // Explicit `checked` > RHF-controlled (onChange wired) > plain boolean `value` > uncontrolled.
        // Coercing to `false` when RHF hasn't hydrated yet avoids the controlled/uncontrolled warning
        // that Radix would otherwise emit on the first user interaction.
        const resolvedChecked: boolean | undefined =
            typeof checked === 'boolean'
                ? checked
                : onChange !== undefined
                  ? Boolean(value)
                  : typeof value === 'boolean'
                    ? value
                    : undefined;

        const handleCheckedChange = (next: boolean | 'indeterminate') => {
            const bool = next === true;
            onCheckedChange?.(bool);
            onChange?.(bool);
        };

        const generatedId = React.useId();
        const inputId = id ?? generatedId;

        const box = (
            <CheckboxPrimitive
                ref={ref}
                id={inputId}
                name={name}
                checked={resolvedChecked}
                defaultChecked={defaultChecked}
                onCheckedChange={handleCheckedChange}
                disabled={disabled}
                className={cn(error ? 'border-destructive' : undefined, className)}
                {...props}
            >
                <CheckboxIndicatorPrimitive>
                    <Icon icon="check" size={16} />
                </CheckboxIndicatorPrimitive>
            </CheckboxPrimitive>
        );

        if (label === undefined || label === null) return box;

        return (
            <label
                htmlFor={inputId}
                className={cn(
                    'inline-flex items-center gap-2 select-none',
                    disabled ? 'cursor-not-allowed opacity-50' : undefined,
                    wrapperClassName,
                )}
            >
                <span className={cn('text-sm text-foreground', labelClassName)}>{label}</span>
                {box}
            </label>
        );
    },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
