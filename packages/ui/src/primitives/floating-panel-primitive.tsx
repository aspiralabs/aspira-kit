'use client';

import * as React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Shared base classes for floating panels — dropdown menus, popovers, select
 * dropdowns, date picker popovers, etc. Ensures they all render with the same
 * border, radius, shadow, background, outline, z-index, and open/close animation
 * contract. Callers add their own padding and width: dropdowns usually want
 * `p-2` + a `min-w-*`, popovers want `p-4` + a fixed width, date pickers want
 * `p-0` so the Calendar controls its own spacing.
 */
export const floatingPanelClassName = [
    'bg-popover',
    'text-popover-foreground',
    'border',
    'rounded-md',
    'shadow-md',
    'outline-none',
    'z-[10000]',
    'data-[state=open]:animate-in',
    'data-[state=closed]:animate-out',
    'data-[state=closed]:fade-out-0',
    'data-[state=open]:fade-in-0',
    'data-[state=closed]:zoom-out-95',
    'data-[state=open]:zoom-in-95',
    'data-[side=bottom]:slide-in-from-top-2',
    'data-[side=left]:slide-in-from-right-2',
    'data-[side=right]:slide-in-from-left-2',
    'data-[side=top]:slide-in-from-bottom-2',
].join(' ');

/**
 * Shared base classes for a single row/option inside a floating panel — select
 * options, dropdown-menu items, command-menu items, etc. This is the item-level
 * counterpart to `floatingPanelClassName`: the ONE place to change the shared
 * geometry (height, padding rhythm, radius) and interactive highlight
 * (`hover:bg-surface` / `focus:bg-surface`) so every menu row stays in lockstep.
 *
 * Callers layer their own specifics on top: text size, default text/icon color,
 * transition flavor, dark-mode active color, and their disabled contract (Radix
 * uses `data-[disabled]`; cmdk always renders `data-disabled="false"`, so those
 * surfaces guard differently — kept out of the shared base on purpose).
 */
export const floatingItemClassName = [
    'relative flex cursor-pointer items-center gap-2',
    'rounded-sm h-10 outline-hidden select-none',
    'hover:bg-surface focus:bg-surface',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    "[&_svg:not([class*='size-'])]:size-4",
].join(' ');

/**
 * Plain wrapper `<div>` with the shared floating-panel visual — for callers that
 * position themselves manually inside a Portal rather than routing through a
 * Radix primitive. Radix-backed consumers should apply `floatingPanelClassName`
 * directly to their own `Content` component so open/close state attributes still
 * drive the animation.
 */
export const FloatingPanelPrimitive = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        data-slot="floating-panel"
        className={cn(floatingPanelClassName, className)}
        {...props}
    />
));
FloatingPanelPrimitive.displayName = 'FloatingPanelPrimitive';

type FloatingPanelProps<T extends React.ElementType> = {
    /**
     * The element/component that supplies the floating *behavior* — typically a
     * Radix `*.Content` (`RadixSelect.Content`, `RadixPopover.Content`, …). It
     * owns positioning, portal wiring, `data-state`/`data-side`, and the ref;
     * FloatingPanel layers the shared panel *visual* on top and forwards
     * everything else (children, position/side offsets, ref) straight through.
     */
    core: T;
    className?: string;
} & Omit<React.ComponentProps<T>, 'className' | 'core'>;

/**
 * Polymorphic floating panel: renders `core` with the shared panel visual baked
 * in. Lets each Radix surface stay declarative — `<FloatingPanel core={RadixSelect.Content} …>`
 * — while every panel's border/shadow/radius/animation stays single-sourced in
 * `floatingPanelClassName`. Pass surface-specific layout (width, padding, origin)
 * via `className`; it merges after the shared base so it can override.
 */
export function FloatingPanel<T extends React.ElementType>({
    core,
    className,
    ...props
}: FloatingPanelProps<T>) {
    const Core = core as React.ElementType;
    return <Core className={cn(floatingPanelClassName, className)} {...props} />;
}
