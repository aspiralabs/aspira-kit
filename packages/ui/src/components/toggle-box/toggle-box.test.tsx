/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToggleBox } from './toggle-box.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

describe('ToggleBox', () => {
    describe('rendering', () => {
        it('renders title and description', () => {
            render(<ToggleBox title="Marketing" description="Emails about new products." />);
            expect(screen.getByText('Marketing')).toBeInTheDocument();
            expect(screen.getByText('Emails about new products.')).toBeInTheDocument();
        });

        it('renders without description', () => {
            render(<ToggleBox title="Marketing" />);
            expect(screen.getByText('Marketing')).toBeInTheDocument();
        });

        it('applies the ChoiceBox-style card layout', () => {
            const { container } = render(<ToggleBox title="Marketing" />);
            const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
            expect(card.className).toContain('rounded-lg');
            expect(card.className).toContain('border');
            expect(card.className).toContain('cursor-pointer');
        });

        it('exposes role="switch" + aria-checked on the outer card', () => {
            render(<ToggleBox title="Marketing" defaultChecked />);
            const card = screen.getByRole('switch');
            expect(card).toHaveAttribute('aria-checked', 'true');
        });
    });

    describe('uncontrolled', () => {
        it('starts off by default', () => {
            render(<ToggleBox title="x" />);
            expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
        });

        it('starts on when defaultChecked is true', () => {
            render(<ToggleBox title="x" defaultChecked />);
            expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
        });

        it('toggles on click anywhere on the card', () => {
            render(<ToggleBox title="x" />);
            const card = screen.getByRole('switch');
            fireEvent.click(card);
            expect(card).toHaveAttribute('aria-checked', 'true');
            fireEvent.click(card);
            expect(card).toHaveAttribute('aria-checked', 'false');
        });

        it('toggles on Space and Enter keys', () => {
            render(<ToggleBox title="x" />);
            const card = screen.getByRole('switch');
            fireEvent.keyDown(card, { key: ' ' });
            expect(card).toHaveAttribute('aria-checked', 'true');
            fireEvent.keyDown(card, { key: 'Enter' });
            expect(card).toHaveAttribute('aria-checked', 'false');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<ToggleBox title="x" onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenCalledWith(true);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenLastCalledWith(false);
        });

        it('does not toggle when disabled', () => {
            render(<ToggleBox title="x" disabled />);
            const card = screen.getByRole('switch');
            fireEvent.click(card);
            expect(card).toHaveAttribute('aria-checked', 'false');
            expect(card).toHaveAttribute('aria-disabled', 'true');
            expect(card).toHaveAttribute('tabindex', '-1');
        });
    });

    describe('controlled (native)', () => {
        it('reflects the checked prop', () => {
            const { rerender } = render(
                <ToggleBox title="x" checked={false} onCheckedChange={() => {}} />,
            );
            expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
            rerender(<ToggleBox title="x" checked={true} onCheckedChange={() => {}} />);
            expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
        });

        it('does not self-update — parent drives state via onCheckedChange', () => {
            render(<ToggleBox title="x" checked={false} onCheckedChange={() => {}} />);
            const card = screen.getByRole('switch');
            fireEvent.click(card);
            expect(card).toHaveAttribute('aria-checked', 'false');
        });

        it('fires onCheckedChange with a plain boolean', () => {
            const onChange = vi.fn();
            render(<ToggleBox title="x" checked={false} onCheckedChange={onChange} />);
            fireEvent.click(screen.getByRole('switch'));
            expect(onChange).toHaveBeenCalledWith(true);
        });
    });

    describe('selected styling', () => {
        it('paints the primary border + ring when checked', () => {
            const { container } = render(<ToggleBox title="x" defaultChecked />);
            const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
            expect(card.className).toContain('border-primary');
            expect(card.className).toContain('ring-primary');
        });

        it('does not paint the selected ring when off', () => {
            const { container } = render(<ToggleBox title="x" />);
            const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
            expect(card.className).not.toContain('ring-primary');
        });
    });

    describe('error', () => {
        it('paints destructive border when error is truthy', () => {
            const { container } = render(
                <ToggleBox title="x" error={{ message: 'Required', type: 'required', ref: null }} />,
            );
            const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
            expect(card.className).toContain('border-destructive');
        });

        it('does not paint destructive border without an error', () => {
            const { container } = render(<ToggleBox title="x" />);
            const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
            expect(card.className).not.toContain('border-destructive');
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits a boolean payload under the name key', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ marketing: z.boolean() });
            const defaults = { marketing: false };

            render(
                <Form schema={schema} defaultValues={defaults} onSubmit={onSubmit}>
                    <ToggleBox name="marketing" title="Marketing" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            // Initial submit — off → false
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ marketing: false }));

            // Toggle via the rendered card, then re-submit → true
            fireEvent.click(screen.getByRole('switch'));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenLastCalledWith({ marketing: true }),
            );
        });

        it('paints destructive border when zod validation fails on submit', async () => {
            const schema = z.object({
                marketing: z.boolean().refine((v) => v === true, { message: 'Must opt in' }),
            });
            const defaults = { marketing: false };

            const { container } = render(
                <Form schema={schema} defaultValues={defaults} onSubmit={() => {}}>
                    <ToggleBox name="marketing" title="Marketing" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const card = container.querySelector('[data-slot="toggle-box"]') as HTMLElement;
                expect(card.className).toContain('border-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ marketing: z.boolean() });
            render(
                <Form
                    schema={schema}
                    defaultValues={{ marketing: false }}
                    pending
                    onSubmit={() => {}}
                >
                    <ToggleBox name="marketing" title="Marketing" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
        });
    });

    describe('BubbleInput loop guard', () => {
        // Regression of the same bug we hit in ChoiceBox: Radix's SwitchPrimitive renders a
        // hidden <input> for form compat; flipping `checked` makes it re-dispatch a click
        // that bubbles up through the card and would toggle again → infinite loop.
        it('does not ping-pong when Radix BubbleInput dispatches a click', async () => {
            const onSubmit = vi.fn();
            const onChange = vi.fn();
            const schema = z.object({ marketing: z.boolean() });
            const defaults = { marketing: false };

            render(
                <Form schema={schema} defaultValues={defaults} onSubmit={onSubmit}>
                    <ToggleBox
                        name="marketing"
                        title="Marketing"
                        onCheckedChange={onChange}
                    />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByRole('switch'));
            fireEvent.click(screen.getByText('Submit'));
            // One toggle → one handler call, not dozens.
            await waitFor(() =>
                expect(onSubmit).toHaveBeenLastCalledWith({ marketing: true }),
            );
            expect(onChange).toHaveBeenCalledTimes(1);
        });
    });
});
