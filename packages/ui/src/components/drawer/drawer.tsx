'use client';

import { NiceModalHandler } from '@ebay/nice-modal-react';
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';

import { Icon } from '../icon/index.js';
import { ScrollArea } from '../scroll-area/index.js';
import { cn } from '../../lib/cn.js';

// ---------------------------------------------------------------------------
// Internal Vaul wrappers (not exported)
// ---------------------------------------------------------------------------

function Overlay({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
    return (
        <DrawerPrimitive.Overlay
            data-slot="drawer-overlay"
            className={cn(
                'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[10000000] bg-surface/80 backdrop-blur-[2px]',
                className,
            )}
            {...props}
        />
    );
}

function Panel({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
    return (
        <DrawerPrimitive.Portal data-slot="drawer-portal">
            <Overlay />
            <DrawerPrimitive.Content
                data-slot="drawer-content"
                className={cn(
                    'group/drawer-content bg-transparent fixed z-[100000000] flex h-auto flex-col p-4',
                    'data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:max-h-[80vh]',
                    'data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:max-h-[80vh]',
                    'data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4',
                    'data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4',
                )}
                {...props}
            >
                <DrawerPrimitive.Title className="sr-only">Drawer</DrawerPrimitive.Title>
                <div
                    className={cn(
                        'bg-background border border-border rounded-xl shadow-lg flex flex-col flex-1 min-h-0 overflow-hidden',
                        className,
                    )}
                >
                    <div className="bg-surface mx-auto mt-4 hidden h-2 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
                    {children}
                </div>
            </DrawerPrimitive.Content>
        </DrawerPrimitive.Portal>
    );
}

// ---------------------------------------------------------------------------
// Drawer — the app-facing API (was DrawerModal)
// ---------------------------------------------------------------------------

type DrawerDirection = 'top' | 'bottom' | 'left' | 'right';

interface DrawerProps {
    children: React.ReactNode;
    className?: string;
    title?: string;
    direction?: DrawerDirection;
    size?: number | string;
    onOutsideClick?: () => void;
    modal: NiceModalHandler<Record<string, unknown>>;
}

const DrawerRoot = ({
    children,
    className = '',
    title = '',
    direction = 'right',
    size = 500,
    onOutsideClick,
    modal,
}: DrawerProps) => {
    const [isMounted, setIsMounted] = useState(false);

    const contentStyle = useMemo(() => {
        if (size === undefined) return undefined;

        const drawerSize = typeof size === 'number' ? `${size}px` : size;

        if (direction === 'left' || direction === 'right') return { width: drawerSize };
        return { height: drawerSize };
    }, [direction, size]);

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            onOutsideClick?.();
            modal.hide();
        }

        setTimeout(() => {
            modal.remove();
        }, 300);
    };

    useEffect(() => {
        if (modal?.visible === false && isMounted) {
            setTimeout(() => {
                modal.remove();
            }, 300);
        }
    }, [modal, isMounted]);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    return (
        <DrawerPrimitive.Root open={modal.visible} onOpenChange={handleOpenChange} direction={direction}>
            <Panel className={cn('p-0', className)} style={contentStyle}>
                <div className="flex h-full min-h-0 flex-col">
                    {title && (
                        <header className="flex items-center justify-between gap-3 p-6 shrink-0">
                            <h2 className="text-xl text-foreground truncate">{title}</h2>
                            <button
                                type="button"
                                onClick={() => handleOpenChange(false)}
                                className="rounded-md p-1 hover:bg-surface transition-colors shrink-0 flex items-center justify-center"
                            >
                                <Icon icon="close" size={20} className="text-foreground-subtext" />
                            </button>
                        </header>
                    )}
                    {children}
                </div>
            </Panel>
        </DrawerPrimitive.Root>
    );
};

// ---------------------------------------------------------------------------
// Drawer.Content — scrollable middle area
// ---------------------------------------------------------------------------
function DrawerContent({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <ScrollArea className={cn('flex-1 min-h-0 px-6', className)}>
            <div className="pb-4">{children}</div>
        </ScrollArea>
    );
}

// ---------------------------------------------------------------------------
// Drawer.Actions — sticky bottom area for buttons
// ---------------------------------------------------------------------------
function DrawerActions({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn('flex justify-end gap-3 p-6 shrink-0', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------
export const Drawer = Object.assign(DrawerRoot, {
    Content: DrawerContent,
    Actions: DrawerActions,
});

export type { DrawerProps, DrawerDirection };
