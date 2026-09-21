/// <reference types="@testing-library/jest-dom" />
import { render, screen, fireEvent } from '@testing-library/react';
import type { NiceModalHandler } from '@ebay/nice-modal-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer } from './drawer.js';

function createMockModal(overrides: Partial<{ visible: boolean }> = {}) {
    return {
        id: 'test-drawer',
        visible: true,
        hide: vi.fn(),
        remove: vi.fn(),
        show: vi.fn(),
        resolve: vi.fn(),
        reject: vi.fn(),
        resolveHide: vi.fn(),
        keepMounted: false,
        ...overrides,
    } as unknown as NiceModalHandler<Record<string, unknown>>;
}

describe('Drawer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('renders children', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal}>
                <p>Drawer content</p>
            </Drawer>,
        );
        expect(screen.getByText('Drawer content')).toBeInTheDocument();
    });

    it('renders title when provided', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal} title="Settings">
                <p>Content</p>
            </Drawer>,
        );
        expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('does not render header when no title', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal}>
                <p>Content</p>
            </Drawer>,
        );
        expect(screen.queryByText('Settings')).not.toBeInTheDocument();
        // Should not have a header element with the close button
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('close button calls hide and schedules remove', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal} title="Test">
                <p>Content</p>
            </Drawer>,
        );

        // Find the close button (it contains the "close" Icon)
        const closeButton = screen.getByRole('button');
        fireEvent.click(closeButton);

        expect(modal.hide).toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(modal.remove).toHaveBeenCalled();
    });

    it('calls onOutsideClick when closing', () => {
        const onOutsideClick = vi.fn();
        const modal = createMockModal();
        render(
            <Drawer modal={modal} title="Test" onOutsideClick={onOutsideClick}>
                <p>Content</p>
            </Drawer>,
        );

        const closeButton = screen.getByRole('button');
        fireEvent.click(closeButton);
        expect(onOutsideClick).toHaveBeenCalled();
    });

    it('auto-removes when modal.visible becomes false after mount', () => {
        const modal = createMockModal({ visible: true });
        const { rerender } = render(
            <Drawer modal={modal}>
                <p>Content</p>
            </Drawer>,
        );

        const hiddenModal = createMockModal({ visible: false });
        hiddenModal.remove = modal.remove;

        rerender(
            <Drawer modal={hiddenModal}>
                <p>Content</p>
            </Drawer>,
        );

        expect(modal.remove).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(modal.remove).toHaveBeenCalled();
    });

    // contentStyle computation is a useMemo inside the component.
    // Vaul's DrawerContent portal doesn't expose data-slot in happy-dom,
    // so we test the logic unit-style instead of querying the DOM.
    describe('contentStyle logic (via rendered output)', () => {
        it('renders without error for all direction + size combos', () => {
            const modal = createMockModal();
            // These should all render without crashing
            const combos = [
                { direction: 'right' as const, size: 400 },
                { direction: 'left' as const, size: '50%' },
                { direction: 'bottom' as const, size: 300 },
                { direction: 'top' as const, size: 200 },
                { direction: 'right' as const, size: undefined },
            ];

            for (const combo of combos) {
                const { unmount } = render(
                    <Drawer modal={modal} direction={combo.direction} size={combo.size}>
                        <p>Content</p>
                    </Drawer>,
                );
                expect(screen.getByText('Content')).toBeInTheDocument();
                unmount();
            }
        });
    });
});

describe('Drawer sizing', () => {
    it('applies size to the inner card, not the positioner, and clamps it to the viewport', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal} direction="right" size={320}>
                <div>body</div>
            </Drawer>,
        );
        const positioner = document.querySelector('[data-slot="drawer-content"]') as HTMLElement;
        const card = positioner.querySelector(':scope > div[style]') as HTMLElement;
        expect(positioner.style.width).toBe('');
        expect(card.style.width).toBe('320px');
        expect(card.className).toContain('max-w-[calc(100dvw-2rem)]');
        expect(card.className).toContain('max-h-[calc(100dvh-2rem)]');
    });

    it('uses height for top/bottom directions', () => {
        const modal = createMockModal();
        render(
            <Drawer modal={modal} direction="bottom" size="40vh">
                <div>body</div>
            </Drawer>,
        );
        const card = document.querySelector('[data-slot="drawer-content"] > div[style]') as HTMLElement;
        expect(card.style.height).toBe('40vh');
        expect(card.style.width).toBe('');
    });
});
