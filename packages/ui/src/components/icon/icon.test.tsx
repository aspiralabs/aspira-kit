/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './icon.js';

describe('Icon', () => {
    it('renders the icon name as text content', () => {
        render(<Icon icon="home" />);
        expect(screen.getByText('home')).toBeInTheDocument();
    });

    it('has data-slot="icon" attribute', () => {
        render(<Icon icon="settings" />);
        expect(screen.getByText('settings').getAttribute('data-slot')).toBe('icon');
    });

    it('applies default size of 24', () => {
        render(<Icon icon="search" />);
        const el = screen.getByText('search');
        expect(el.style.fontSize).toBe('24px');
        expect(el.style.width).toBe('24px');
        expect(el.style.height).toBe('24px');
    });

    it('applies custom size', () => {
        render(<Icon icon="star" size={16} />);
        const el = screen.getByText('star');
        expect(el.style.fontSize).toBe('16px');
        expect(el.style.width).toBe('16px');
        expect(el.style.height).toBe('16px');
    });

    it('sets FILL to 0 by default (not filled)', () => {
        render(<Icon icon="favorite" />);
        const el = screen.getByText('favorite');
        expect(el.style.fontVariationSettings).toContain("'FILL' 0");
    });

    it('sets FILL to 1 when fill is true', () => {
        render(<Icon icon="favorite" fill />);
        const el = screen.getByText('favorite');
        expect(el.style.fontVariationSettings).toContain("'FILL' 1");
    });

    it('applies custom weight', () => {
        render(<Icon icon="bold" weight={700} />);
        const el = screen.getByText('bold');
        expect(el.style.fontVariationSettings).toContain("'wght' 700");
    });

    it('applies default weight of 400', () => {
        render(<Icon icon="text" />);
        const el = screen.getByText('text');
        expect(el.style.fontVariationSettings).toContain("'wght' 400");
    });

    it('applies custom className', () => {
        render(<Icon icon="add" className="text-destructive" />);
        const el = screen.getByText('add');
        expect(el.classList.contains('text-destructive')).toBe(true);
    });

    it('has material-symbols-sharp class', () => {
        render(<Icon icon="check" />);
        const el = screen.getByText('check');
        expect(el.classList.contains('material-symbols-sharp')).toBe(true);
    });
});
