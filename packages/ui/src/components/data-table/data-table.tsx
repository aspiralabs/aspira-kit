'use client';

import {
    Cell,
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    Header,
    HeaderGroup,
    Row,
    SortingState,
    useReactTable,
} from '@tanstack/react-table';

import { Button } from '../button/index.js';
import {
    TableBodyPrimitive,
    TableCellPrimitive,
    TableHeadPrimitive,
    TableHeaderPrimitive,
    TablePrimitive,
    TableRowPrimitive,
} from '../../primitives/table-primitive.js';
import { defaultNavigate, type Navigate } from '../../lib/navigate.js';
import { useState } from 'react';

interface DataTableProps<TData> {
    columns: ColumnDef<TData>[];
    data: TData[];
    onRowClick?: string;
    hideHeader?: boolean;
    /** Row-click navigation. Defaults to a full page load; pass `useRouter().push` in Next.js. */
    navigate?: Navigate;
}

export function DataTable<TData extends Record<string, unknown>>({
    columns,
    data,
    onRowClick,
    hideHeader = false,
    navigate = defaultNavigate,
}: DataTableProps<TData>) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        state: {
            sorting,
        },
    });

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

    const showPagination = table.getPageCount() > 1;

    return (
        <div>
            <div className="border border-border rounded-xl overflow-hidden">
                <TablePrimitive>
                    {!hideHeader && (
                        <TableHeaderPrimitive>
                            {table.getHeaderGroups().map((headerGroup: HeaderGroup<TData>) => (
                                <TableRowPrimitive key={headerGroup.id} className="h-12 hover:bg-transparent">
                                    {headerGroup.headers.map((header: Header<TData, unknown>) => {
                                        return (
                                            <TableHeadPrimitive
                                                key={header.id}
                                                className="h-12 text-xs font-medium uppercase tracking-wider text-foreground-subtext"
                                                style={header.column.getSize() !== 150 ? { width: header.column.getSize() } : undefined}
                                            >
                                                {!header.isPlaceholder &&
                                                    flexRender(header.column.columnDef.header, header.getContext())}
                                            </TableHeadPrimitive>
                                        );
                                    })}
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
                                    className={onRowClick ? 'cursor-pointer hover:bg-surface/50' : ''}
                                    onClick={(e) => handleRowClick(row, e)}
                                >
                                    {row.getVisibleCells().map((cell: Cell<TData, unknown>) => (
                                        <TableCellPrimitive
                                            key={cell.id}
                                            style={cell.column.getSize() !== 150 ? { width: cell.column.getSize() } : undefined}
                                        >
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCellPrimitive>
                                    ))}
                                </TableRowPrimitive>
                            ))}
                        {!table.getRowModel().rows?.length && (
                            <TableRowPrimitive>
                                <TableCellPrimitive colSpan={columns.length} className="h-24 text-center">
                                    No results.
                                </TableCellPrimitive>
                            </TableRowPrimitive>
                        )}
                    </TableBodyPrimitive>
                </TablePrimitive>
            </div>
            {showPagination && (
                <div className="flex items-center justify-end space-x-2 py-4">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                    >
                        Next
                    </Button>
                </div>
            )}
        </div>
    );
}
