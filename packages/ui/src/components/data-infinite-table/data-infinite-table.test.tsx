/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { render, screen, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DataInfiniteTable } from './data-infinite-table.js';

type Row = { id: string; name: string };
const columns: ColumnDef<Row>[] = [{ accessorKey: 'name', header: 'Name' }];

function wrap(ui: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function queryFor(items: Row[], delayMs = 0) {
    return {
        queryKey: ['rows', delayMs] as const,
        queryFn: () => new Promise<{ items: Row[]; nextCursor: string | null }>((r) => setTimeout(() => r({ items, nextCursor: null }), delayMs)),
        initialPageParam: undefined,
        getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
        retry: 0,
    };
}

describe('DataInfiniteTable', () => {
    it('renders eight skeleton rows under the header while the first page loads, without stretching', () => {
        const { container } = wrap(<DataInfiniteTable columns={columns} queryFn={queryFor([], 10_000)} />);
        expect(screen.getByText('Name')).toBeInTheDocument();
        expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(8);
        const box = container.firstElementChild as HTMLElement;
        expect(box.className).not.toContain('h-full');
    });

    it('renders the rows once the page resolves', async () => {
        wrap(<DataInfiniteTable columns={columns} queryFn={queryFor([{ id: '1', name: 'Alice' }])} />);
        await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
        expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    });
});
