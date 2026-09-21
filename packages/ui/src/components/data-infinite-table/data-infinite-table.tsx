'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
    Cell,
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    Header,
    HeaderGroup,
    Row,
    SortingState,
    useReactTable,
} from '@tanstack/react-table';

import { ScrollArea } from '../scroll-area/index.js';
import {
    TableBodyPrimitive,
    TableCellPrimitive,
    TableHeadPrimitive,
    TableHeaderPrimitive,
    TablePrimitive,
    TableRowPrimitive,
} from '../../primitives/table-primitive.js';
import { cn } from '../../lib/cn.js';
import { defaultNavigate, type Navigate } from '../../lib/navigate.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '../skeleton/index.js';

interface InfiniteQueryOptions<TData> {
    queryKey: readonly unknown[];
    queryFn: ({ pageParam }: { pageParam?: string }) => Promise<{
        items: TData[];
        nextCursor: string | null;
    }>;
    initialPageParam: string | undefined;
    getNextPageParam: (lastPage: { nextCursor: string | null }) => string | undefined;
    retry: number;
}

interface DataInfiniteTableProps<TData> {
    columns: ColumnDef<TData>[];
    queryFn: InfiniteQueryOptions<TData>;
    onRowClick?: string;
    hideHeader?: boolean;
    emptyState?: React.ReactNode;
    /** Row-click navigation. Defaults to a full page load; pass `useRouter().push` in Next.js. */
    navigate?: Navigate;
}

export function DataInfiniteTable<TData extends Record<string, unknown>>({
    columns,
    queryFn: queryOptions,
    onRowClick,
    hideHeader = false,
    emptyState,
    navigate = defaultNavigate,
}: DataInfiniteTableProps<TData>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const scrollViewportRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;

    // Execute the query using the provided queryFn options
    const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery(queryOptions);

    // Flatten all pages into a single array
    const tableData = useMemo(() => data?.pages.flatMap((page) => page.items) || [], [data]);

    const table = useReactTable({
        data: tableData,
        columns,
        getCoreRowModel: getCoreRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        state: {
            sorting,
        },
    });

    const colGroup = useMemo(() => {
        const hasFixedCols = columns.some((col) => col.size && col.size !== 150);
        if (!hasFixedCols) return null;
        return (
            <colgroup>
                {columns.map((col, i) => {
                    const style = col.size && col.size !== 150 ? { width: col.size } : undefined;
                    return <col key={i} style={style} />;
                })}
            </colgroup>
        );
    }, [columns]);

    // Intersection observer for infinite scrolling
    useEffect(() => {
        if (!loadMoreRef.current || !hasNextPage || !scrollViewportRef.current) return;

        const currentRef = loadMoreRef.current;
        const scrollViewport = scrollViewportRef.current;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
                    fetchNextPage();
                }
            },
            { root: scrollViewport, rootMargin: '100px' },
        );

        observer.observe(currentRef);

        return () => {
            observer.unobserve(currentRef);
            observer.disconnect();
        };
    }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    const handleRowClick = (row: Row<TData>, event: React.MouseEvent) => {
        if (!onRowClick) return;

        // Don't trigger if user is selecting text
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;

        // Don't trigger if clicking on a button or link
        const target = event.target as HTMLElement;
        if (target.closest('button, a')) return;

        const url = onRowClick.replace(/<([^>]+)>/g, (_, key) => {
            const value = row.original[key];
            return value?.toString() || '';
        });

        navigate(url);
    };

    if (isLoading) {
        // Hug the skeleton rows instead of stretching the bordered box to full
        // height — a short table in a tall empty box (with a dangling column
        // rule) reads as broken. Render enough rows to look like a real table.
        return (
            <div className="border border-border rounded-xl overflow-hidden">
                <TablePrimitive>
                    {colGroup}
                    {!hideHeader && (
                        <TableHeaderPrimitive>
                            {table.getHeaderGroups().map((headerGroup: HeaderGroup<TData>) => (
                                <TableRowPrimitive key={headerGroup.id} className="h-12 hover:bg-transparent">
                                    {headerGroup.headers.map((header: Header<TData, unknown>) => (
                                        <TableHeadPrimitive
                                            key={header.id}
                                            className="h-12 text-xs font-medium uppercase tracking-wider text-foreground-subtext"
                                        >
                                            {!header.isPlaceholder &&
                                                flexRender(header.column.columnDef.header, header.getContext())}
                                        </TableHeadPrimitive>
                                    ))}
                                </TableRowPrimitive>
                            ))}
                        </TableHeaderPrimitive>
                    )}
                    <TableBodyPrimitive>
                        {Array.from({ length: 8 }).map((_, i) => (
                            <TableRowPrimitive key={i} className="hover:bg-transparent">
                                {columns.map((_, j) => (
                                    <TableCellPrimitive key={j}>
                                        <Skeleton className="h-4 w-24" />
                                    </TableCellPrimitive>
                                ))}
                            </TableRowPrimitive>
                        ))}
                    </TableBodyPrimitive>
                </TablePrimitive>
            </div>
        );
    }

    if (!table.getRowModel().rows?.length && emptyState) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                {emptyState}
            </div>
        );
    }

    return (
        <div className="border border-border rounded-xl overflow-hidden h-full">
        <ScrollArea className="h-full w-full" viewPortRef={scrollViewportRef}>
            <TablePrimitive>
                {colGroup}
                {!hideHeader && (
                    <TableHeaderPrimitive>
                        {table.getHeaderGroups().map((headerGroup: HeaderGroup<TData>) => (
                            <TableRowPrimitive key={headerGroup.id} className="h-12 hover:bg-transparent">
                                {headerGroup.headers.map((header: Header<TData, unknown>) => (
                                    <TableHeadPrimitive
                                        key={header.id}
                                        className="h-12 text-xs font-medium uppercase tracking-wider text-foreground-subtext"
                                    >
                                        {!header.isPlaceholder &&
                                            flexRender(header.column.columnDef.header, header.getContext())}
                                    </TableHeadPrimitive>
                                ))}
                            </TableRowPrimitive>
                        ))}
                    </TableHeaderPrimitive>
                )}
                <TableBodyPrimitive>
                    {table.getRowModel().rows?.length > 0 &&
                        table.getRowModel().rows.map((row: Row<TData>) => (
                            <TableRowPrimitive
                                key={row.id}
                                data-state={row.getIsSelected() && 'selected'}
                                className={onRowClick && 'cursor-pointer hover:bg-surface/50'}
                                onClick={(e) => handleRowClick(row, e)}
                            >
                                {row.getVisibleCells().map((cell: Cell<TData, unknown>) => (
                                    <TableCellPrimitive key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </TableCellPrimitive>
                                ))}
                            </TableRowPrimitive>
                        ))}
                    {!table.getRowModel().rows?.length && (
                        <TableRowPrimitive className="hover:bg-transparent">
                            <TableCellPrimitive colSpan={columns.length} className="h-24 text-center">
                                No results.
                            </TableCellPrimitive>
                        </TableRowPrimitive>
                    )}
                </TableBodyPrimitive>
            </TablePrimitive>
            <div
                ref={loadMoreRef}
                className={cn('flex items-center justify-center space-x-2', hasNextPage ? 'py-4' : 'h-0 overflow-hidden')}
            >
                {isFetchingNextPage && (
                    <div className="flex items-center gap-2">
                        <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        <span>Loading more...</span>
                    </div>
                )}
            </div>
        </ScrollArea>
        </div>
    );
}
