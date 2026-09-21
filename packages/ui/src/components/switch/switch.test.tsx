/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Switch } from './switch.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

describe('Switch', () => {
    describe('uncontrolled', () => {
        it('starts off by default', () => {
            render(<Switch aria-label="test" />);
            expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
        });

        it('starts on when defaultChecked is true', () => {
            render(<Switch aria-label="test" defaultChecked />);
            expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked');
        });

        it('toggles on click', () => {
            render(<Switch aria-label="test" />);
            const toggle = screen.getByRole('switch');
            fireEvent.click(toggle);
            expect(toggle).toHaveAttribute('data-state', 'checked');
            fireEvent.click(toggle);
            expect(toggle).toHaveAttribute('data-state', 'unchecked');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<Switch aria-label="test" onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenCalledWith(true);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenLastCalledWith(false);
        });

        it('does not toggle when disabled', () => {
            render(<Switch aria-label="test" disabled />);
            const toggle = screen.getByRole('switch');
            fireEvent.click(toggle);
            expect(toggle).toHaveAttribute('data-state', 'unchecked');
        });
    });

    describe('controlled (native)', () => {
        it('reflects the checked prop', () => {
            const { rerender } = render(
                <Switch aria-label="test" checked={false} onCheckedChange={() => {}} />,
            );
            expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
            rerender(<Switch aria-label="test" checked={true} onCheckedChange={() => {}} />);
            expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked');
        });

        it('does not self-update — parent drives state via onCheckedChange', () => {
            render(<Switch aria-label="test" checked={false} onCheckedChange={() => {}} />);
            const toggle = screen.getByRole('switch');
            fireEvent.click(toggle);
            // Parent never updated `checked`, so the DOM state must not change
            expect(toggle).toHaveAttribute('data-state', 'unchecked');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<Switch aria-label="test" checked={false} onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenCalledWith(true);
        });
    });

    describe('label', () => {
        it('renders the label text', () => {
            render(<Switch label="Subscribe" />);
            expect(screen.getByText('Subscribe')).toBeInTheDocument();
        });

        it('wraps content in a <label> tied via htmlFor to the switch id', () => {
            render(<Switch label="Subscribe" id="subscribe" />);
            const labelEl = screen.getByText('Subscribe').closest('label');
            expect(labelEl?.getAttribute('for')).toBe('subscribe');
        });

        it('auto-generates an id and links it via htmlFor when none is provided', () => {
            render(<Switch label="Subscribe" />);
            const labelEl = screen.getByText('Subscribe').closest('label') as HTMLLabelElement;
            const forAttr = labelEl.getAttribute('for');
            expect(forAttr).toBeTruthy();
            expect(screen.getByRole('switch').id).toBe(forAttr);
        });

        it('renders label text to the left of the toggle', () => {
            render(<Switch label="Subscribe" />);
            const labelEl = screen.getByText('Subscribe').closest('label') as HTMLElement;
            const span = Array.from(labelEl.children).findIndex((c) => c.tagName === 'SPAN');
            const button = Array.from(labelEl.children).findIndex((c) => c.tagName === 'BUTTON');
            expect(span).toBeGreaterThanOrEqual(0);
            expect(button).toBeGreaterThanOrEqual(0);
            expect(span).toBeLessThan(button);
        });

        it('renders bare (no <label>) when label is omitted', () => {
            const { container } = render(<Switch aria-label="bare" />);
            expect(container.querySelector('label')).toBeNull();
        });
    });

    describe('error', () => {
        it('applies destructive ring when error is truthy', () => {
            render(
                <Switch
                    aria-label="test"
                    error={{ message: 'Required', type: 'required', ref: null }}
                />,
            );
            expect(screen.getByRole('switch').className).toContain('ring-destructive');
        });

        it('does not apply destructive ring without an error', () => {
            render(<Switch aria-label="test" />);
            expect(screen.getByRole('switch').className).not.toContain('ring-destructive');
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits a boolean payload under the switch name', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ newsletter: z.boolean() });

            render(
                <Form
                    schema={schema}
                    defaultValues={{ newsletter: false }}
                    onSubmit={onSubmit}
                >
                    <Switch name="newsletter" label="Subscribe" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            // Initial submit — off → false
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ newsletter: false }));

            // Toggle via the rendered switch, then re-submit → true
            fireEvent.click(screen.getByRole('switch'));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenLastCalledWith({ newsletter: true }),
            );
        });

        it('paints destructive ring when zod validation fails on submit', async () => {
            const schema = z.object({
                newsletter: z.boolean().refine((v) => v === true, { message: 'Must subscribe' }),
            });

            render(
                <Form
                    schema={schema}
                    defaultValues={{ newsletter: false }}
                    onSubmit={() => {}}
                >
                    <Switch name="newsletter" label="Subscribe" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                expect(screen.getByRole('switch').className).toContain('ring-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ newsletter: z.boolean() });
            render(
                <Form
                    schema={schema}
                    defaultValues={{ newsletter: false }}
                    pending
                    onSubmit={() => {}}
                >
                    <Switch name="newsletter" label="Subscribe" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            expect(screen.getByRole('switch')).toBeDisabled();
        });
    });
});
