'use client';

import * as RadixPopover from '@radix-ui/react-popover';
import * as React from 'react';

import { cn } from '../lib/cn.js';
import { FloatingPanel } from './floating-panel-primitive.js';

const PopoverPrimitive = RadixPopover.Root;

const PopoverTriggerPrimitive = RadixPopover.Trigger;

const PopoverContentPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixPopover.Content>,
    React.ComponentPropsWithoutRef<typeof RadixPopover.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
    <RadixPopover.Portal>
        {/* Panel visual comes from the shared FloatingPanel; RadixPopover.Content is
            passed as `core` so it keeps owning positioning. Popover-specific defaults
            (width + padding) layer on top and can still be overridden by the caller. */}
        <FloatingPanel
            core={RadixPopover.Content}
            ref={ref}
            align={align}
            sideOffset={sideOffset}
            className={cn('w-72 p-4', className)}
            {...props}
        />
    </RadixPopover.Portal>
));
PopoverContentPrimitive.displayName = RadixPopover.Content.displayName;

export { PopoverPrimitive, PopoverContentPrimitive, PopoverTriggerPrimitive };
