/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { ColumnDef } from '@tanstack/react-table';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './data-table.js';

type TestRow = { id: string; name: string; email: string };

const columns: ColumnDef<TestRow>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'email', header: 'Email' },
];

const data: TestRow[] = [
    { id: '1', name: 'Alice', email: 'alice@test.com' },
    { id: '2', name: 'Bob', email: 'bob@test.com' },
    { id: '3', name: 'Carol', email: 'carol@test.com' },
];

// The kit's DataTable has no framework dependency: row-click navigation goes
// through the `navigate` prop (a Next app passes `useRouter().push`).
const mockPush = vi.fn();

beforeEach(() => {
    mockPush.mockClear();
});

describe('DataTable', () => {
    describe('rendering', () => {
        it('renders column headers and row data', () => {
            render(<DataTable columns={columns} data={data} />);
            expect(screen.getByText('Name')).toBeInTheDocument();
            expect(screen.getByText('Email')).toBeInTheDocument();
            expect(screen.getByText('Alice')).toBeInTheDocument();
            expect(screen.getByText('bob@test.com')).toBeInTheDocument();
        });

        it('shows "No results." for empty data', () => {
            render(<DataTable columns={columns} data={[]} />);
            expect(screen.getByText('No results.')).toBeInTheDocument();
        });

        it('hides header when hideHeader is true', () => {
            render(<DataTable columns={columns} data={data} hideHeader />);
            expect(screen.queryByText('Name')).not.toBeInTheDocument();
            expect(screen.queryByText('Email')).not.toBeInTheDocument();
            // Data should still render
            expect(screen.getByText('Alice')).toBeInTheDocument();
        });
    });

    describe('row click navigation', () => {
        it('navigates with URL template interpolation', () => {
            render(<DataTable columns={columns} data={data} navigate={mockPush} onRowClick="/users/<id>" />);

            fireEvent.click(screen.getByText('Alice'));
            expect(mockPush).toHaveBeenCalledWith('/users/1');
        });

        it('interpolates multiple template tokens', () => {
            render(<DataTable columns={columns} data={data} navigate={mockPush} onRowClick="/users/<id>/emails/<email>" />);

            fireEvent.click(screen.getByText('Bob'));
            expect(mockPush).toHaveBeenCalledWith('/users/2/emails/bob@test.com');
        });

        it('does not navigate when onRowClick is not set', () => {
            render(<DataTable columns={columns} data={data} />);

            fireEvent.click(screen.getByText('Alice'));
            expect(mockPush).not.toHaveBeenCalled();
        });

        it('does not navigate when clicking a button inside the row', () => {
            const columnsWithButton: ColumnDef<TestRow>[] = [
                ...columns,
                {
                    id: 'actions',
                    cell: () => <button>Delete</button>,
                },
            ];

            render(<DataTable columns={columnsWithButton} data={data} navigate={mockPush} onRowClick="/users/<id>" />);

            fireEvent.click(screen.getAllByText('Delete')[0]!);
            expect(mockPush).not.toHaveBeenCalled();
        });

        it('does not navigate when clicking a link inside the row', () => {
            const columnsWithLink: ColumnDef<TestRow>[] = [
                ...columns,
                {
                    id: 'actions',
                    // preventDefault keeps jsdom from trying to follow the link (it logs "Not implemented: navigation").
                    cell: () => (
                        <a href="/somewhere" onClick={(e) => e.preventDefault()}>
                            View
                        </a>
                    ),
                },
            ];

            render(<DataTable columns={columnsWithLink} data={data} navigate={mockPush} onRowClick="/users/<id>" />);

            fireEvent.click(screen.getAllByText('View')[0]!);
            expect(mockPush).not.toHaveBeenCalled();
        });

        it('does not navigate when user is selecting text', () => {
            render(<DataTable columns={columns} data={data} navigate={mockPush} onRowClick="/users/<id>" />);

            // Mock window.getSelection to return a non-empty selection
            const originalGetSelection = window.getSelection;
            window.getSelection = vi.fn(() => ({ toString: () => 'selected text' }) as unknown as Selection);

            fireEvent.click(screen.getByText('Alice'));
            expect(mockPush).not.toHaveBeenCalled();

            window.getSelection = originalGetSelection;
        });
    });

    describe('pagination', () => {
        it('does not show pagination when data fits in one page', () => {
            render(<DataTable columns={columns} data={data} />);
            expect(screen.queryByText('Previous')).not.toBeInTheDocument();
            expect(screen.queryByText('Next')).not.toBeInTheDocument();
        });

        it('shows pagination when data exceeds page size', () => {
            // Default TanStack Table page size is 10, so create 11+ rows
            const manyRows: TestRow[] = Array.from({ length: 12 }, (_, i) => ({
                id: String(i),
                name: `User ${i}`,
                email: `user${i}@test.com`,
            }));

            render(<DataTable columns={columns} data={manyRows} />);
            expect(screen.getByText('Previous')).toBeInTheDocument();
            expect(screen.getByText('Next')).toBeInTheDocument();
        });

        it('disables Previous on first page and enables Next', () => {
            const manyRows: TestRow[] = Array.from({ length: 12 }, (_, i) => ({
                id: String(i),
                name: `User ${i}`,
                email: `user${i}@test.com`,
            }));

            render(<DataTable columns={columns} data={manyRows} />);
            expect(screen.getByText('Previous')).toBeDisabled();
            expect(screen.getByText('Next')).toBeEnabled();
        });

        it('enables Previous and disables Next on last page', () => {
            const manyRows: TestRow[] = Array.from({ length: 12 }, (_, i) => ({
                id: String(i),
                name: `User ${i}`,
                email: `user${i}@test.com`,
            }));

            render(<DataTable columns={columns} data={manyRows} />);

            fireEvent.click(screen.getByText('Next'));
            expect(screen.getByText('Previous')).toBeEnabled();
            expect(screen.getByText('Next')).toBeDisabled();
        });
    });
});

describe('DataTable loading', () => {
    it('keeps the header and renders skeleton rows instead of data', () => {
        const { container } = render(<DataTable columns={columns} data={data} loading skeletonRows={3} />);
        expect(screen.getByText('Name')).toBeInTheDocument();
        expect(screen.queryByText('Alice')).toBeNull();
        expect(screen.queryByText('No results.')).toBeNull();
        const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
        expect(skeletons).toHaveLength(3 * columns.length);
    });

    it('defaults to five skeleton rows', () => {
        const { container } = render(<DataTable columns={columns} data={[]} loading />);
        expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    });

    it('shows data again once loading is false', () => {
        const { rerender } = render(<DataTable columns={columns} data={data} loading />);
        rerender(<DataTable columns={columns} data={data} />);
        expect(screen.getByText('Alice')).toBeInTheDocument();
    });
});
