'use client';

import * as React from 'react';

import { cn } from '../lib/cn.js';

const TablePrimitive = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
    ({ className, ...props }, ref) => (
        <div className="relative w-full">
            <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
        </div>
    ),
);
TablePrimitive.displayName = 'TablePrimitive';

const TableHeaderPrimitive = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
    ({ className, ...props }, ref) => <thead ref={ref} className={cn('border-b border-border', className)} {...props} />,
);
TableHeaderPrimitive.displayName = 'TableHeaderPrimitive';

const TableBodyPrimitive = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
    ({ className, ...props }, ref) => <tbody ref={ref} className={cn('', className)} {...props} />,
);
TableBodyPrimitive.displayName = 'TableBodyPrimitive';

const TableFooterPrimitive = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
    ({ className, ...props }, ref) => (
        <tfoot ref={ref} className={cn('bg-primary font-medium text-primary-foreground', className)} {...props} />
    ),
);
TableFooterPrimitive.displayName = 'TableFooterPrimitive';

const TableRowPrimitive = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
    ({ className, ...props }, ref) => (
        <tr
            ref={ref}
            className={cn(
                'group/row h-14 border-b border-border last:border-b-0 transition-colors hover:bg-surface/40 data-[state=selected]:bg-surface',
                className,
            )}
            {...props}
        />
    ),
);
TableRowPrimitive.displayName = 'TableRowPrimitive';

const TableHeadPrimitive = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
    ({ className, ...props }, ref) => (
        <th
            ref={ref}
            className={cn(
                'h-12 px-4 text-left align-middle text-xs font-medium uppercase tracking-wider text-foreground-subtext border-r border-border last:border-r-0 [&:has([role=checkbox])]:pr-0',
                className,
            )}
            {...props}
        />
    ),
);
TableHeadPrimitive.displayName = 'TableHeadPrimitive';

const TableCellPrimitive = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
    ({ className, ...props }, ref) => (
        <td ref={ref} className={cn('px-4 py-3 align-middle border-r border-border last:border-r-0 max-w-0 overflow-hidden text-ellipsis whitespace-nowrap [&:has([role=checkbox])]:pr-0', className)} {...props} />
    ),
);
TableCellPrimitive.displayName = 'TableCellPrimitive';

const TableCaptionPrimitive = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
    ({ className, ...props }, ref) => (
        <caption ref={ref} className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
    ),
);
TableCaptionPrimitive.displayName = 'TableCaptionPrimitive';

export {
    TablePrimitive,
    TableBodyPrimitive,
    TableCaptionPrimitive,
    TableCellPrimitive,
    TableFooterPrimitive,
    TableHeadPrimitive,
    TableHeaderPrimitive,
    TableRowPrimitive,
};
