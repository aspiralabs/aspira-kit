import { cn } from '../../lib/cn.js';
import { TooltipPortal } from '@radix-ui/react-tooltip';
import { JSX } from 'react';
import {
    TooltipContentPrimitive,
    TooltipPrimitive,
    TooltipTriggerPrimitive,
} from '../../primitives/tooltip-primitive.js';

interface TooltipProps {
    children: JSX.Element;
    text?: string | number;
    side?: 'top' | 'bottom' | 'left' | 'right';
    render?: () => JSX.Element;
    className?: string;
    triggerClassName?: string;
}

export const Tooltip = ({ children, text, side = 'top', render, className, triggerClassName }: TooltipProps) => {
    if (!render && !text) return children;

    return (
        <TooltipPrimitive disableHoverableContent delayDuration={0}>
            <TooltipTriggerPrimitive asChild className={cn('flex-1', triggerClassName)}>
                {children}
            </TooltipTriggerPrimitive>
            <TooltipPortal>
                <TooltipContentPrimitive side={side} className={cn('max-w-[300px]', className)}>
                    {render ? render() : text}
                </TooltipContentPrimitive>
            </TooltipPortal>
        </TooltipPrimitive>
    );
};

export type { TooltipProps };
