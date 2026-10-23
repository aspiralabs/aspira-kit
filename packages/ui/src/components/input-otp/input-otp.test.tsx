/// <reference types="@testing-library/jest-dom" />
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { Form } from '../form/index.js';
import { InputOTP } from './input-otp.js';

function container(root: HTMLElement) {
    return root.querySelector('[data-slot=input-otp-group]')!.parentElement as HTMLElement;
}

describe('InputOTP stretch', () => {
    it('keeps the fixed-width slots by default', () => {
        const { container: root } = render(<InputOTP length={6} />);
        const slots = root.querySelectorAll('[data-slot=input-otp-slot]');
        expect(slots).toHaveLength(6);
        expect(slots[0]).toHaveClass('w-12');
        expect(container(root)).not.toHaveClass('w-full');
    });

    it('fills the width with the length shortcut', () => {
        const { container: root } = render(<InputOTP length={6} stretch />);
        expect(container(root)).toHaveClass('w-full');
        expect(container(root).className).toContain('[&_[data-slot=input-otp-slot]]:flex-1');
        expect(container(root).className).toContain('[&_[data-slot=input-otp-group]]:flex-1');
    });

    it('passes through when Form wires it by name', () => {
        const schema = z.object({ otp: z.string() });
        const { container: root } = render(
            <Form schema={schema} onSubmit={() => {}}>
                <InputOTP name="otp" label="Code" length={6} stretch />
            </Form>,
        );
        expect(container(root)).toHaveClass('w-full');
    });
});
