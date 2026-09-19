'use client';

import * as RadixSelect from '@radix-ui/react-select';
import * as React from 'react';

import { cn } from '../lib/cn.js';
import { Icon } from '../components/icon/index.js';
import { FloatingPanel, floatingItemClassName } from './floating-panel-primitive.js';

function SelectPrimitive({ ...props }: React.ComponentProps<typeof RadixSelect.Root>) {
    return <RadixSelect.Root data-slot="select" {...props} />;
}

function SelectGroupPrimitive({ ...props }: React.ComponentProps<typeof RadixSelect.Group>) {
    return <RadixSelect.Group data-slot="select-group" {...props} />;
}

function SelectValuePrimitive({ ...props }: React.ComponentProps<typeof RadixSelect.Value>) {
    return <RadixSelect.Value data-slot="select-value" {...props} />;
}

function SelectTriggerPrimitive({
    className,
    size = 'default',
    children,
    ...props
}: React.ComponentProps<typeof RadixSelect.Trigger> & {
    size?: 'xs' | 'sm' | 'default';
}) {
    return (
        <RadixSelect.Trigger
            data-slot="select-trigger"
            data-size={size}
            className={cn(
                `flex w-fit items-center justify-between gap-2
                border border-input rounded-lg bg-surface
                px-3 py-2 whitespace-nowrap
                outline-none transition-colors
                text-foreground
                data-[placeholder]:text-muted-foreground
                data-[size=default]:h-[56px] data-[size=default]:text-base
                data-[size=sm]:h-10 data-[size=sm]:text-sm
                data-[size=xs]:h-8 data-[size=xs]:text-xs
                hover:border-primary focus-visible:border-primary
                aria-invalid:border-destructive
                disabled:cursor-not-allowed disabled:opacity-50
                *:data-[slot=select-value]:line-clamp-1
                *:data-[slot=select-value]:flex
                *:data-[slot=select-value]:items-center
                *:data-[slot=select-value]:gap-2
                [&_svg]:pointer-events-none [&_svg]:shrink-0
                [&_svg:not([class*='text-'])]:text-muted-foreground
                [&_svg:not([class*='size-'])]:size-4`,
                className,
            )}
            {...props}
        >
            {children}
            <RadixSelect.Icon asChild>
                <Icon icon="keyboard_arrow_down" size={20} className="opacity-50" />
            </RadixSelect.Icon>
        </RadixSelect.Trigger>
    );
}

function SelectContentPrimitive({
    className,
    children,
    header,
    position = 'popper',
    ...props
}: React.ComponentProps<typeof RadixSelect.Content> & {
    /** Static content rendered above the scroll-up button. Stays pinned when the
     *  list overflows — useful for search inputs that shouldn't scroll with items. */
    header?: React.ReactNode;
}) {
    return (
        <RadixSelect.Portal>
            {/* Panel visual comes from the shared FloatingPanel; RadixSelect.Content
                is passed as `core` so it keeps owning positioning + scroll behavior.
                Select-specific layout (scroll, available-height cap, trigger-origin)
                rides on className. */}
            <FloatingPanel
                core={RadixSelect.Content}
                data-slot="select-content"
                position={position}
                className={cn(
                    `relative overflow-x-hidden overflow-y-auto
                    max-h-(--radix-select-content-available-height)
                    min-w-[8rem] origin-(--radix-select-content-transform-origin)`,
                    position === 'popper' &&
                        `data-[side=bottom]:translate-y-1
                        data-[side=left]:-translate-x-1
                        data-[side=right]:translate-x-1
                        data-[side=top]:-translate-y-1`,
                    className,
                )}
                {...props}
            >
                {header}
                <SelectScrollUpButtonPrimitive />
                <RadixSelect.Viewport
                    className={cn(
                        'p-2',
                        position === 'popper' &&
                            'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1',
                    )}
                >
                    {children}
                </RadixSelect.Viewport>
                <SelectScrollDownButtonPrimitive />
            </FloatingPanel>
        </RadixSelect.Portal>
    );
}

function SelectLabelPrimitive({ className, ...props }: React.ComponentProps<typeof RadixSelect.Label>) {
    return (
        <RadixSelect.Label
            data-slot="select-label"
            className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
            {...props}
        />
    );
}

function SelectItemPrimitive({ className, children, ...props }: React.ComponentProps<typeof RadixSelect.Item>) {
    return (
        <RadixSelect.Item
            data-slot="select-item"
            className={cn(
                // Shared item geometry + highlight from the one primitive;
                // select-specific bits (full width, check-indicator padding,
                // text size, disabled + default icon color) layer on top.
                floatingItemClassName,
                `w-full pr-8 pl-2 text-sm transition
                dark:hover:bg-gray-arsenic dark:focus:bg-gray-arsenic focus:text-foreground
                data-[disabled]:pointer-events-none data-[disabled]:opacity-50
                [&_svg:not([class*='text-'])]:text-muted-foreground
                *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2`,
                className,
            )}
            {...props}
        >
            <span className="absolute right-2 flex size-3.5 items-center justify-center">
                <RadixSelect.ItemIndicator>
                    <Icon icon="check" size={16} className="text-foreground" />
                </RadixSelect.ItemIndicator>
            </span>
            <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
        </RadixSelect.Item>
    );
}

function SelectSeparatorPrimitive({ className, ...props }: React.ComponentProps<typeof RadixSelect.Separator>) {
    return (
        <RadixSelect.Separator
            data-slot="select-separator"
            className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
            {...props}
        />
    );
}

function SelectScrollUpButtonPrimitive({
    className,
    ...props
}: React.ComponentProps<typeof RadixSelect.ScrollUpButton>) {
    return (
        <RadixSelect.ScrollUpButton
            data-slot="select-scroll-up-button"
            className={cn('flex cursor-default items-center justify-center py-1', className)}
            {...props}
        >
            <Icon icon="keyboard_arrow_up" size={16} />
        </RadixSelect.ScrollUpButton>
    );
}

function SelectScrollDownButtonPrimitive({
    className,
    ...props
}: React.ComponentProps<typeof RadixSelect.ScrollDownButton>) {
    return (
        <RadixSelect.ScrollDownButton
            data-slot="select-scroll-down-button"
            className={cn('flex cursor-default items-center justify-center py-1', className)}
            {...props}
        >
            <Icon icon="keyboard_arrow_down" size={16} />
        </RadixSelect.ScrollDownButton>
    );
}

export {
    SelectPrimitive,
    SelectContentPrimitive,
    SelectGroupPrimitive,
    SelectItemPrimitive,
    SelectLabelPrimitive,
    SelectScrollDownButtonPrimitive,
    SelectScrollUpButtonPrimitive,
    SelectSeparatorPrimitive,
    SelectTriggerPrimitive,
    SelectValuePrimitive,
};
