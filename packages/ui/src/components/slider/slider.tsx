'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '../../lib/cn.js';

interface SliderProps extends React.ComponentProps<typeof SliderPrimitive.Root> {
    /**
     * Optional error signal. When truthy, the thumbs and range paint with the
     * destructive color so `<Form>` validation errors are visible.
     */
    error?: unknown;
}

function Slider({
    className,
    defaultValue,
    value,
    min = 0,
    max = 100,
    error,
    ...props
}: SliderProps) {
    // Radix's SliderPrimitive.Root expects `number[]` for both value and defaultValue. If a
    // caller (or the <Form> branch) hands us a scalar number — e.g. when the RHF field is
    // typed as `z.number()` — coerce it to a single-element array so Radix's internal
    // `values.map(...)` calls don't blow up. Direct callers with `number[]` are unaffected.
    const normalizedValue = typeof value === 'number' ? [value] : value;
    const normalizedDefault = typeof defaultValue === 'number' ? [defaultValue] : defaultValue;

    const _values = React.useMemo(
        () =>
            Array.isArray(normalizedValue)
                ? normalizedValue
                : Array.isArray(normalizedDefault)
                  ? normalizedDefault
                  : [min, max],
        [normalizedValue, normalizedDefault, min, max],
    );

    const dataError = error ? '' : undefined;

    return (
        <SliderPrimitive.Root
            data-slot="slider"
            data-error={dataError}
            defaultValue={normalizedDefault}
            value={normalizedValue}
            min={min}
            max={max}
            className={cn(
                'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
                className,
            )}
            {...props}
        >
            <SliderPrimitive.Track
                data-slot="slider-track"
                className={cn(
                    'bg-surface relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5',
                )}
            >
                <SliderPrimitive.Range
                    data-slot="slider-range"
                    className={cn(
                        'absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
                        error ? 'bg-destructive' : 'bg-primary',
                    )}
                />
            </SliderPrimitive.Track>
            {Array.from({ length: _values.length }, (_, index) => (
                <SliderPrimitive.Thumb
                    data-slot="slider-thumb"
                    key={index}
                    className={cn(
                        'bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50',
                        error ? 'border-destructive' : 'border-primary',
                    )}
                />
            ))}
        </SliderPrimitive.Root>
    );
}

Slider.displayName = 'Slider';

export { Slider };
