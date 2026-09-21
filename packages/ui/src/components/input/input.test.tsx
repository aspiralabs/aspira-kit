/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Input } from './input.js';

// Reproduces the RecipeTimeSelector pattern: a controlled, masked Input whose
// onValueChange feeds parent state that is passed straight back as `value`.
// A fresh inline mask object is created every render on purpose — that is
// exactly what the real call-site does and what used to trigger the loop.
function ControlledMaskedInput({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
        <Input
            label="Hours"
            inputMode="numeric"
            mask={{ mask: Number, scale: 0, min: 0 }}
            value={value}
            onValueChange={({ value }) => setValue(value)}
        />
    );
}

describe('Input (masked, controlled)', () => {
    it('mounts a controlled masked input without an infinite render loop', () => {
        // A render loop surfaces in jsdom as "Maximum update depth exceeded"
        // thrown during render. render() would throw; assert it does not.
        expect(() => render(<ControlledMaskedInput initial="0" />)).not.toThrow();
        const input = screen.getByRole('textbox') as HTMLInputElement;
        expect(input.value).toBe('0');
    });

    it('preserves a non-zero initial value instead of clearing it', () => {
        render(<ControlledMaskedInput initial="30" />);
        const input = screen.getByRole('textbox') as HTMLInputElement;
        expect(input.value).toBe('30');
    });

    it('still reports genuine user edits through onValueChange', () => {
        const onValueChange = vi.fn();
        render(
            <Input
                label="Minutes"
                inputMode="numeric"
                mask={{ mask: Number, scale: 0, min: 0, max: 59 }}
                value="0"
                onValueChange={onValueChange}
            />,
        );
        const input = screen.getByRole('textbox') as HTMLInputElement;
        onValueChange.mockClear();
        fireEvent.input(input, { target: { value: '45' } });
        expect(onValueChange).toHaveBeenCalledWith(expect.objectContaining({ value: '45' }));
    });
});

describe('Input (sync echo guard)', () => {
    it('reports a clear back to empty through onValueChange', () => {
        // The guard swallows the mask's empty emission on mount. It must be
        // one-shot: clearing the field later is a real edit and must be reported.
        const onValueChange = vi.fn();
        render(<Input label="Name" defaultValue="Jane" onValueChange={onValueChange} />);
        const input = screen.getByRole('textbox') as HTMLInputElement;
        onValueChange.mockClear();
        fireEvent.input(input, { target: { value: '' } });
        expect(onValueChange).toHaveBeenLastCalledWith(expect.objectContaining({ value: '' }));
    });

    it('does not echo a programmatic value change back through onValueChange', () => {
        function Parent() {
            const [value, setValue] = useState('a');
            return (
                <>
                    <Input label="Name" value={value} onValueChange={onValueChange} />
                    <button type="button" onClick={() => setValue('programmatic')}>
                        set
                    </button>
                </>
            );
        }
        const onValueChange = vi.fn();
        render(<Parent />);
        onValueChange.mockClear();
        fireEvent.click(screen.getByText('set'));
        expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('programmatic');
        expect(onValueChange).not.toHaveBeenCalled();
    });
});

describe('Input (password)', () => {
    it('renders type=password with a show/hide toggle that is out of the tab order', () => {
        const { container } = render(<Input label="Password" type="password" defaultValue="hunter2" />);
        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.type).toBe('password');
        const toggle = screen.getByRole('button', { name: 'Show password' });
        expect(toggle).toHaveAttribute('tabindex', '-1');
    });

    it('reveals and re-hides the value on toggle', () => {
        const { container } = render(<Input label="Password" type="password" defaultValue="hunter2" />);
        const input = container.querySelector('input') as HTMLInputElement;
        fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
        expect(input.type).toBe('text');
        fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
        expect(input.type).toBe('password');
    });

    it('renders no toggle for other types and follows disabled', () => {
        const { rerender } = render(<Input label="Email" type="email" />);
        expect(screen.queryByRole('button', { name: /password/ })).toBeNull();
        rerender(<Input label="Password" type="password" disabled />);
        expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
    });
});
