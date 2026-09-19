'use client';

import * as RadixTooltip from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '../lib/cn.js';

const TooltipProviderPrimitive = RadixTooltip.Provider;

const TooltipPrimitive = RadixTooltip.Root;

const TooltipTriggerPrimitive = RadixTooltip.Trigger;

const TooltipContentPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixTooltip.Content>,
    React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
    <RadixTooltip.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
            'z-[115] pointer-events-none overflow-hidden rounded-none text-center bg-primary px-3 py-1.5 text-xs text-white dark:text-black shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
        )}
        {...props}
    />
));
TooltipContentPrimitive.displayName = RadixTooltip.Content.displayName;

export { TooltipPrimitive, TooltipContentPrimitive, TooltipProviderPrimitive, TooltipTriggerPrimitive };
