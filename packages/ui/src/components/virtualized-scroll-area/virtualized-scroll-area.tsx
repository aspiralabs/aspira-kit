'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';

import { ScrollArea } from '../scroll-area/index.js';

interface VirtualizedScrollAreaProps<T> {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    overscan?: number;
    estimateSize: (index: number) => number;
    getItemKey?: (index: number) => string | number;
    listHeight: number;
    className?: string;
    initialScroll?: {
        index: number;
        clickAfterScroll: boolean;
    };
}

export interface VirtualizedScrollAreaRef {
    scrollToIndex: (
        index: number,
        options?: {
            align?: 'start' | 'center' | 'end';
            behavior?: 'auto' | 'smooth';
        },
    ) => void;
}

const VirtualizedScrollArea = <T,>({
    items,
    renderItem,
    overscan = 5,
    estimateSize,
    getItemKey,
    listHeight,
    initialScroll,
    className,
    ...props
}: VirtualizedScrollAreaProps<T>) => {
    const parentRef = React.useRef<HTMLDivElement>(null);

    const getScrollElement = React.useCallback(() => parentRef.current, []);
    const defaultGetItemKey = React.useCallback((index: number) => index, []);

    const rowVirtualizer = useVirtualizer({
        count: items.length,
        getScrollElement,
        estimateSize: estimateSize,
        overscan,
        getItemKey: getItemKey || defaultGetItemKey,
    });

    const virtualItems = rowVirtualizer.getVirtualItems();

    React.useEffect(() => {
        if (!initialScroll) {
            return;
        }
        if (initialScroll?.index > -1) {
            rowVirtualizer.scrollToIndex(initialScroll.index, {
                align: 'start',
                behavior: 'auto',
            });

            if (initialScroll?.clickAfterScroll) {
                setTimeout(() => {
                    const targetElement = parentRef.current?.querySelector(
                        `[data-virtual-index="${initialScroll.index}"]`,
                    );
                    const renderedElement = targetElement?.children[0];
                    if (renderedElement instanceof HTMLElement) {
                        renderedElement.click();
                    }
                }, 100);
            }
        }
    }, [initialScroll?.index, initialScroll?.clickAfterScroll]);

    return (
        <ScrollArea style={{ height: `${listHeight}px` }} viewPortRef={parentRef} className={className} {...props}>
            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {virtualItems.map((virtualItem) => (
                    <div
                        key={virtualItem.key}
                        data-virtual-index={virtualItem.index}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualItem.size}px`,
                            transform: `translateY(${virtualItem.start}px)`,
                        }}
                    >
                        {renderItem(items[virtualItem.index] as T, virtualItem.index)}
                    </div>
                ))}
            </div>
        </ScrollArea>
    );
};

VirtualizedScrollArea.displayName = 'VirtualizedScrollArea';

export { VirtualizedScrollArea };
