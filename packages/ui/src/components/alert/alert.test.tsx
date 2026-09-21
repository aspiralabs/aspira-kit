/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert, AlertTitle, AlertDescription } from './alert.js';

describe('Alert', () => {
    it('renders children content', () => {
        render(
            <Alert>
                <AlertTitle>Warning</AlertTitle>
                <AlertDescription>Something happened</AlertDescription>
            </Alert>,
        );
        expect(screen.getByText('Warning')).toBeInTheDocument();
        expect(screen.getByText('Something happened')).toBeInTheDocument();
    });

    it('has role="alert" for accessibility', () => {
        render(<Alert>Content</Alert>);
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('renders default "info" icon for default variant', () => {
        render(<Alert>Content</Alert>);
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('info');
    });

    it('renders "error" icon for destructive variant', () => {
        render(<Alert variant="destructive">Content</Alert>);
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('error');
    });

    it('renders "check_circle" icon for success variant', () => {
        render(<Alert variant="success">Content</Alert>);
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('check_circle');
    });

    it('renders "info" icon for blue variant', () => {
        render(<Alert variant="blue">Content</Alert>);
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('info');
    });

    it('uses custom icon when icon prop is provided', () => {
        render(<Alert icon="warning">Content</Alert>);
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('warning');
    });

    it('custom icon overrides variant default', () => {
        render(
            <Alert variant="destructive" icon="shield">
                Content
            </Alert>,
        );
        const alert = screen.getByRole('alert');
        const iconEl = alert.querySelector('[data-slot="alert-icon"]');
        expect(iconEl?.textContent).toBe('shield');
    });

    it('has data-slot="alert" attribute', () => {
        render(<Alert>Content</Alert>);
        expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('alert');
    });
});
