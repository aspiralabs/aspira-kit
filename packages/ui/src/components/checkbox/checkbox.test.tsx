/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Checkbox } from './checkbox.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

describe('Checkbox', () => {
    describe('uncontrolled', () => {
        it('starts unchecked by default', () => {
            render(<Checkbox aria-label="test" />);
            expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
        });

        it('starts checked when defaultChecked is true', () => {
            render(<Checkbox aria-label="test" defaultChecked />);
            expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
        });

        it('toggles on click', () => {
            render(<Checkbox aria-label="test" />);
            const box = screen.getByRole('checkbox');
            fireEvent.click(box);
            expect(box).toHaveAttribute('data-state', 'checked');
            fireEvent.click(box);
            expect(box).toHaveAttribute('data-state', 'unchecked');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<Checkbox aria-label="test" onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onChange).toHaveBeenCalledWith(true);
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onChange).toHaveBeenLastCalledWith(false);
        });

        it('does not toggle when disabled', () => {
            render(<Checkbox aria-label="test" disabled />);
            const box = screen.getByRole('checkbox');
            fireEvent.click(box);
            expect(box).toHaveAttribute('data-state', 'unchecked');
        });
    });

    describe('controlled (native)', () => {
        it('reflects the checked prop', () => {
            const { rerender } = render(
                <Checkbox aria-label="test" checked={false} onCheckedChange={() => {}} />,
            );
            expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
            rerender(<Checkbox aria-label="test" checked={true} onCheckedChange={() => {}} />);
            expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
        });

        it('does not self-update — parent drives state via onCheckedChange', () => {
            render(<Checkbox aria-label="test" checked={false} onCheckedChange={() => {}} />);
            const box = screen.getByRole('checkbox');
            fireEvent.click(box);
            // Parent never updated `checked`, so the DOM state must not change
            expect(box).toHaveAttribute('data-state', 'unchecked');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<Checkbox aria-label="test" checked={false} onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onChange).toHaveBeenCalledWith(true);
        });
    });

    describe('label', () => {
        it('renders the label text', () => {
            render(<Checkbox label="Accept terms" />);
            expect(screen.getByText('Accept terms')).toBeInTheDocument();
        });

        it('wraps content in a <label> tied via htmlFor to the checkbox id', () => {
            render(<Checkbox label="Accept" id="accept-box" />);
            const labelEl = screen.getByText('Accept').closest('label');
            expect(labelEl?.getAttribute('for')).toBe('accept-box');
        });

        it('auto-generates an id and links it via htmlFor when none is provided', () => {
            render(<Checkbox label="Accept" />);
            const labelEl = screen.getByText('Accept').closest('label') as HTMLLabelElement;
            const forAttr = labelEl.getAttribute('for');
            expect(forAttr).toBeTruthy();
            expect(screen.getByRole('checkbox').id).toBe(forAttr);
        });

        it('renders label text to the left of the checkbox', () => {
            render(<Checkbox label="Accept" />);
            const labelEl = screen.getByText('Accept').closest('label') as HTMLElement;
            const span = Array.from(labelEl.children).findIndex((c) => c.tagName === 'SPAN');
            const button = Array.from(labelEl.children).findIndex((c) => c.tagName === 'BUTTON');
            expect(span).toBeGreaterThanOrEqual(0);
            expect(button).toBeGreaterThanOrEqual(0);
            expect(span).toBeLessThan(button);
        });

        it('renders bare (no <label>) when label is omitted', () => {
            const { container } = render(<Checkbox aria-label="bare" />);
            expect(container.querySelector('label')).toBeNull();
        });
    });

    describe('error', () => {
        it('applies destructive border when error is truthy', () => {
            render(
                <Checkbox
                    aria-label="test"
                    error={{ message: 'Required', type: 'required', ref: null }}
                />,
            );
            expect(screen.getByRole('checkbox').className).toContain('border-destructive');
        });

        it('does not apply destructive border without an error', () => {
            render(<Checkbox aria-label="test" />);
            expect(screen.getByRole('checkbox').className).not.toContain('border-destructive');
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits a boolean payload under the checkbox name', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ accept: z.boolean() });

            render(
                <Form
                    schema={schema}
                    defaultValues={{ accept: false }}
                    onSubmit={onSubmit}
                >
                    <Checkbox name="accept" label="Accept" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            // Initial submit — unchecked → false
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ accept: false }));

            // Toggle via the rendered checkbox, then re-submit → true
            fireEvent.click(screen.getByRole('checkbox'));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ accept: true }));
        });

        it('paints destructive border when zod validation fails on submit', async () => {
            const schema = z.object({
                accept: z.boolean().refine((v) => v === true, { message: 'Must accept' }),
            });

            render(
                <Form schema={schema} defaultValues={{ accept: false }} onSubmit={() => {}}>
                    <Checkbox name="accept" label="Accept" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                expect(screen.getByRole('checkbox').className).toContain('border-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ accept: z.boolean() });
            render(
                <Form
                    schema={schema}
                    defaultValues={{ accept: false }}
                    pending
                    onSubmit={() => {}}
                >
                    <Checkbox name="accept" label="Accept" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            expect(screen.getByRole('checkbox')).toBeDisabled();
        });
    });
});
