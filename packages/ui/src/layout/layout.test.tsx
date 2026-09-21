/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProviderPrimitive } from '../primitives/tooltip-primitive.js';
import { PageHeader } from './page-header.js';
import { Section } from './section.js';
import { StandardToolbar } from './standard-toolbar.js';

describe('Section', () => {
    it('renders a <section> and closes with a rule when divider is set', () => {
        const { container, rerender } = render(
            <Section>
                <Section.Content>body</Section.Content>
            </Section>,
        );
        const el = container.querySelector('section') as HTMLElement;
        expect(el).toBeInTheDocument();
        expect(el.className).not.toContain('border-b');
        rerender(
            <Section divider>
                <Section.Content>body</Section.Content>
            </Section>,
        );
        expect((container.querySelector('section') as HTMLElement).className).toContain('border-b');
    });
});

describe('PageHeader', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <TooltipProviderPrimitive>{children}</TooltipProviderPrimitive>;

    it('renders the description under the title when given', () => {
        render(<PageHeader config={{ title: 'Users', description: 'Everyone in the org' }} />, { wrapper });
        expect(screen.getAllByText('Users').length).toBeGreaterThan(0);
        // desktop + mobile headers both carry it
        expect(screen.getAllByText('Everyone in the org')).toHaveLength(2);
    });

    it('marks the active tab default and the rest ghost', () => {
        const onTabChange = vi.fn();
        render(
            <PageHeader
                config={{
                    title: 'Users',
                    menu: [
                        { label: 'Active', paramKey: 'active' },
                        { label: 'Archived', paramKey: 'archived' },
                    ],
                    activeTab: 'active',
                    onTabChange,
                }}
            />,
            { wrapper },
        );
        const [active] = screen.getAllByRole('button', { name: 'Active' });
        const [archived] = screen.getAllByRole('button', { name: 'Archived' });
        expect(active!.className).toContain('bg-primary');
        expect(archived!.className).not.toContain('bg-primary');
        fireEvent.click(archived!);
        expect(onTabChange).toHaveBeenCalledWith('archived');
    });
});

describe('StandardToolbar', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <TooltipProviderPrimitive>{children}</TooltipProviderPrimitive>;
    const filters = [
        { key: 'role', label: 'Role', options: [{ value: 'admin', label: 'Admin' }, { value: 'user', label: 'User' }] },
        { key: 'status', label: 'Status', multi: false, options: [{ value: 'on', label: 'On' }] },
    ];

    it('renders active filter chips with labels and removes one on click', () => {
        const onFilterChange = vi.fn();
        render(<StandardToolbar filters={filters} filterValues={{ role: ['admin'] }} onFilterChange={onFilterChange} />, { wrapper });
        expect(screen.getByText('Admin')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Admin').querySelector('button')!);
        expect(onFilterChange).toHaveBeenCalledWith({ role: [] });
    });

    it('renders a skeleton chip while a remote label has not hydrated', () => {
        const { container } = render(
            <StandardToolbar
                filters={[{ key: 'owner', label: 'Owner', dataMode: 'remote', baseEndpoint: '/x', getOptionLabel: () => undefined }]}
                filterValues={{ owner: ['42'] }}
            />,
            { wrapper },
        );
        expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
        expect(screen.queryByText('42')).toBeNull();
    });
});
