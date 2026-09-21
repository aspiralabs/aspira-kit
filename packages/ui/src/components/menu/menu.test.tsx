/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Menu } from './menu.js';

describe('Menu', () => {
    it('maps danger to the destructive item variant and runs the action', () => {
        const action = vi.fn();
        render(
            <Menu
                options={[
                    { key: 'edit', label: 'Edit', action: vi.fn() },
                    { key: 'delete', label: 'Delete', variant: 'danger', action },
                ]}
            >
                <button type="button">open</button>
            </Menu>,
        );
        // jsdom has no PointerEvent; Radix also opens the menu on Enter from the trigger.
        fireEvent.keyDown(screen.getByText('open'), { key: 'Enter' });
        const del = screen.getByText('Delete').closest('[role="menuitem"]') as HTMLElement;
        expect(del).toHaveAttribute('data-variant', 'destructive');
        expect((screen.getByText('Edit').closest('[role="menuitem"]') as HTMLElement)).toHaveAttribute('data-variant', 'default');
        fireEvent.click(del);
        expect(action).toHaveBeenCalled();
    });
});
