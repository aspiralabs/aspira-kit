'use client';

import * as RadixCheckbox from '@radix-ui/react-checkbox';
import * as React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Styled wrapper around `@radix-ui/react-checkbox` Root. Encapsulates the shared
 * visual identity (16×16 primary-bordered square, data-state driven fill, focus
 * ring, disabled affordance) so higher-level consumers — `<Checkbox>`,
 * `<ChoiceBox mode="multi">`, etc. — render an identical checkbox without
 * duplicating Tailwind classes.
 */
const CheckboxPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixCheckbox.Root>,
    React.ComponentPropsWithoutRef<typeof RadixCheckbox.Root>
>(({ className, ...props }, ref) => (
    <RadixCheckbox.Root
        ref={ref}
        className={cn(
            'peer size-4 shrink-0 flex items-center justify-center border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
            className,
        )}
        {...props}
    />
));
CheckboxPrimitive.displayName = RadixCheckbox.Root.displayName;

/**
 * Styled wrapper around `@radix-ui/react-checkbox` Indicator. Consumers compose
 * their own icon/child inside. Note: this uses `@radix-ui/react-presence`
 * internally — when nested inside a role="checkbox" ancestor that re-renders
 * frequently (e.g. inside a React Hook Form Controller) Presence's ref-attach
 * effect can loop; in that case render a check icon as a direct child of
 * `CheckboxPrimitive` instead of using this indicator.
 */
const CheckboxIndicatorPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixCheckbox.Indicator>,
    React.ComponentPropsWithoutRef<typeof RadixCheckbox.Indicator>
>(({ className, ...props }, ref) => (
    <RadixCheckbox.Indicator
        ref={ref}
        className={cn('flex items-center justify-center text-current', className)}
        {...props}
    />
));
CheckboxIndicatorPrimitive.displayName = RadixCheckbox.Indicator.displayName;

export { CheckboxPrimitive, CheckboxIndicatorPrimitive };
