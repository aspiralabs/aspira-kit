/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditableText } from './editable-text.js';

describe('EditableText', () => {
    it('displays value as text by default', () => {
        render(<EditableText value="Hello World" />);
        expect(screen.getByText('Hello World')).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('enters edit mode on double-click', () => {
        render(<EditableText value="Hello" />);
        fireEvent.doubleClick(screen.getByText('Hello'));
        expect(screen.getByRole('textbox')).toBeInTheDocument();
        expect(screen.getByRole('textbox')).toHaveValue('Hello');
    });

    it('saves on Enter key and exits edit mode', () => {
        const onSave = vi.fn();
        render(<EditableText value="Original" onSave={onSave} />);

        fireEvent.doubleClick(screen.getByText('Original'));
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: 'Updated' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onSave).toHaveBeenCalledWith('Updated');
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('cancels on Escape key without calling onSave', () => {
        const onSave = vi.fn();
        render(<EditableText value="Original" onSave={onSave} />);

        fireEvent.doubleClick(screen.getByText('Original'));
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: 'Changed' } });
        fireEvent.keyDown(input, { key: 'Escape' });

        expect(onSave).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.getByText('Original')).toBeInTheDocument();
    });

    it('saves on blur', () => {
        const onSave = vi.fn();
        render(<EditableText value="Original" onSave={onSave} />);

        fireEvent.doubleClick(screen.getByText('Original'));
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: 'Blurred' } });
        fireEvent.blur(input);

        expect(onSave).toHaveBeenCalledWith('Blurred');
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('does not call onSave when value is unchanged', () => {
        const onSave = vi.fn();
        render(<EditableText value="Same" onSave={onSave} />);

        fireEvent.doubleClick(screen.getByText('Same'));
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

        expect(onSave).not.toHaveBeenCalled();
    });

    it('does not call onSave on blur after Escape (cancelledRef)', () => {
        const onSave = vi.fn();
        render(<EditableText value="Original" onSave={onSave} />);

        fireEvent.doubleClick(screen.getByText('Original'));
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: 'Changed' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.blur(input);

        expect(onSave).not.toHaveBeenCalled();
    });

    it('updates display when external value prop changes', () => {
        const { rerender } = render(<EditableText value="V1" />);
        expect(screen.getByText('V1')).toBeInTheDocument();

        rerender(<EditableText value="V2" />);
        expect(screen.getByText('V2')).toBeInTheDocument();
    });

    it('updates input value in real-time while editing', () => {
        render(<EditableText value="Start" />);

        fireEvent.doubleClick(screen.getByText('Start'));
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: 'Typing...' } });
        expect(input).toHaveValue('Typing...');
    });
});
