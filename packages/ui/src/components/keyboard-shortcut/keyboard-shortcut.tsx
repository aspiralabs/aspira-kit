import * as React from 'react';

import { cn } from '../../lib/cn.js';

function KeyboardShortcut({ className, ...props }: React.ComponentProps<'kbd'>) {
    return (
        <kbd
            data-slot="kbd"
            className={cn(
                'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-surface px-1.5 font-sans text-xs font-medium text-muted-foreground select-none',
                "[&_svg:not([class*='size-'])]:size-3",
                '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10',
                className,
            )}
            {...props}
        />
    );
}

function KeyboardShortcutGroup({ className, ...props }: React.ComponentProps<'div'>) {
    return <kbd data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />;
}

export { KeyboardShortcut, KeyboardShortcutGroup };
