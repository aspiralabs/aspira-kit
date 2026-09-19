'use client';

import * as RadixSwitch from '@radix-ui/react-switch';
import * as React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Styled wrapper around `@radix-ui/react-switch` Root. Encapsulates the shared
 * visual identity (pill track, primary fill on checked, focus ring, disabled
 * affordance) so higher-level consumers — `<Switch>`, `<ToggleBox>`, etc. —
 * render an identical toggle without duplicating Tailwind classes.
 */
const SwitchPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixSwitch.Root>,
    React.ComponentPropsWithoutRef<typeof RadixSwitch.Root>
>(({ className, ...props }, ref) => (
    <RadixSwitch.Root
        ref={ref}
        className={cn(
            'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-surface focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-surface/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
            className,
        )}
        {...props}
    />
));
SwitchPrimitive.displayName = RadixSwitch.Root.displayName;

/**
 * Styled wrapper around `@radix-ui/react-switch` Thumb. Slides across the
 * track via `data-[state=checked]:translate-x-*`.
 */
const SwitchThumbPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixSwitch.Thumb>,
    React.ComponentPropsWithoutRef<typeof RadixSwitch.Thumb>
>(({ className, ...props }, ref) => (
    <RadixSwitch.Thumb
        ref={ref}
        className={cn(
            'bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0',
            className,
        )}
        {...props}
    />
));
SwitchThumbPrimitive.displayName = RadixSwitch.Thumb.displayName;

export { SwitchPrimitive, SwitchThumbPrimitive };
