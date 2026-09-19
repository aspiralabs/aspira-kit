'use client';

import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import * as React from 'react';

import { cn } from '../lib/cn.js';
import { Icon } from '../components/icon/index.js';
import { floatingItemClassName, floatingPanelClassName } from './floating-panel-primitive.js';

function DropdownMenuPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.Root>) {
    return <RadixDropdownMenu.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortalPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.Portal>) {
    return <RadixDropdownMenu.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTriggerPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.Trigger>) {
    return <RadixDropdownMenu.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

// Floating panel visual (border, shadow, bg, animations, z-index) comes from the
// shared primitive; dropdown-specific bits (origin + min-width + padding) layer on top.
const DROPDOWN_CONTENT_BASE = cn(
    floatingPanelClassName,
    'min-w-[8rem] p-2 origin-(--radix-dropdown-menu-content-transform-origin)',
);

// Shared item geometry + highlight from the one primitive; dropdown-specific
// bits (padding, text size/color, transition, dark hover, disabled) layer on top.
const DROPDOWN_ITEM_BASE = cn(
    floatingItemClassName,
    'px-2 text-base text-foreground transition-colors dark:hover:bg-background dark:focus:bg-background data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
);

function DropdownMenuContentPrimitive({
    className,
    sideOffset = 4,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.Content>) {
    return (
        <RadixDropdownMenu.Portal>
            <RadixDropdownMenu.Content
                data-slot="dropdown-menu-content"
                sideOffset={sideOffset}
                className={cn(
                    DROPDOWN_CONTENT_BASE,
                    'max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto',
                    className,
                )}
                {...props}
            />
        </RadixDropdownMenu.Portal>
    );
}

function DropdownMenuGroupPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.Group>) {
    return <RadixDropdownMenu.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItemPrimitive({
    className,
    inset,
    variant = 'default',
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
}) {
    return (
        <RadixDropdownMenu.Item
            data-slot="dropdown-menu-item"
            data-inset={inset}
            data-variant={variant}
            className={cn(
                DROPDOWN_ITEM_BASE,
                "data-[inset]:pl-8 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:hover:bg-destructive/20 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:!text-destructive",
                className,
            )}
            {...props}
        />
    );
}

function DropdownMenuCheckboxItemPrimitive({
    className,
    children,
    checked,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.CheckboxItem>) {
    return (
        <RadixDropdownMenu.CheckboxItem
            data-slot="dropdown-menu-checkbox-item"
            className={cn(DROPDOWN_ITEM_BASE, 'pl-8', className)}
            checked={checked}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <RadixDropdownMenu.ItemIndicator>
                    <Icon icon="check" size={16} />
                </RadixDropdownMenu.ItemIndicator>
            </span>
            {children}
        </RadixDropdownMenu.CheckboxItem>
    );
}

function DropdownMenuRadioGroupPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.RadioGroup>) {
    return <RadixDropdownMenu.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItemPrimitive({
    className,
    children,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.RadioItem>) {
    return (
        <RadixDropdownMenu.RadioItem
            data-slot="dropdown-menu-radio-item"
            className={cn(DROPDOWN_ITEM_BASE, 'pl-8', className)}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <RadixDropdownMenu.ItemIndicator>
                    <Icon icon="circle" size={8} className="fill-current" />
                </RadixDropdownMenu.ItemIndicator>
            </span>
            {children}
        </RadixDropdownMenu.RadioItem>
    );
}

function DropdownMenuLabelPrimitive({
    className,
    inset,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.Label> & {
    inset?: boolean;
}) {
    return (
        <RadixDropdownMenu.Label
            data-slot="dropdown-menu-label"
            data-inset={inset}
            className={cn('px-2 py-1.5 text-base font-medium data-[inset]:pl-8', className)}
            {...props}
        />
    );
}

function DropdownMenuSeparatorPrimitive({ className, ...props }: React.ComponentProps<typeof RadixDropdownMenu.Separator>) {
    return (
        <RadixDropdownMenu.Separator
            data-slot="dropdown-menu-separator"
            className={cn('bg-border -mx-1 my-1 h-px', className)}
            {...props}
        />
    );
}

function DropdownMenuShortcutPrimitive({ className, ...props }: React.ComponentProps<'span'>) {
    return (
        <span
            data-slot="dropdown-menu-shortcut"
            className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
            {...props}
        />
    );
}

function DropdownMenuSubPrimitive({ ...props }: React.ComponentProps<typeof RadixDropdownMenu.Sub>) {
    return <RadixDropdownMenu.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTriggerPrimitive({
    className,
    inset,
    children,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.SubTrigger> & {
    inset?: boolean;
}) {
    return (
        <RadixDropdownMenu.SubTrigger
            data-slot="dropdown-menu-sub-trigger"
            data-inset={inset}
            className={cn(
                DROPDOWN_ITEM_BASE,
                'data-[state=open]:bg-surface data-[inset]:pl-8',
                className,
            )}
            {...props}
        >
            {children}
            <Icon icon="keyboard_arrow_right" size={16} className="ml-auto" />
        </RadixDropdownMenu.SubTrigger>
    );
}

function DropdownMenuSubContentPrimitive({
    className,
    ...props
}: React.ComponentProps<typeof RadixDropdownMenu.SubContent>) {
    return (
        <RadixDropdownMenu.SubContent
            data-slot="dropdown-menu-sub-content"
            className={cn(DROPDOWN_CONTENT_BASE, 'overflow-hidden', className)}
            {...props}
        />
    );
}

export {
    DropdownMenuPrimitive,
    DropdownMenuCheckboxItemPrimitive,
    DropdownMenuContentPrimitive,
    DropdownMenuGroupPrimitive,
    DropdownMenuItemPrimitive,
    DropdownMenuLabelPrimitive,
    DropdownMenuPortalPrimitive,
    DropdownMenuRadioGroupPrimitive,
    DropdownMenuRadioItemPrimitive,
    DropdownMenuSeparatorPrimitive,
    DropdownMenuShortcutPrimitive,
    DropdownMenuSubPrimitive,
    DropdownMenuSubContentPrimitive,
    DropdownMenuSubTriggerPrimitive,
    DropdownMenuTriggerPrimitive,
};
