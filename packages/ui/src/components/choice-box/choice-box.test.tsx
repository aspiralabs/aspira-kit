/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChoiceBox } from './choice-box.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

const TONE_OPTIONS = [
    { title: 'Professional', description: 'Clear and confident.', value: 'professional' },
    { title: 'Friendly', description: 'Warm and approachable.', value: 'friendly' },
    { title: 'Playful', value: 'playful' },
];

const CHANNEL_OPTIONS = [
    { title: 'Email', value: 'email' },
    { title: 'Slack', value: 'slack' },
    { title: 'Push', value: 'push' },
];

describe('ChoiceBox', () => {
    describe('rendering', () => {
        it('renders each option as a button', () => {
            render(<ChoiceBox options={TONE_OPTIONS} />);
            expect(screen.getAllByRole('radio')).toHaveLength(3);
        });

        it('renders titles and descriptions', () => {
            render(<ChoiceBox options={TONE_OPTIONS} />);
            expect(screen.getByText('Professional')).toBeInTheDocument();
            expect(screen.getByText('Clear and confident.')).toBeInTheDocument();
            expect(screen.getByText('Friendly')).toBeInTheDocument();
        });

        it('omits description when not provided', () => {
            render(<ChoiceBox options={TONE_OPTIONS} />);
            expect(screen.getByText('Playful')).toBeInTheDocument();
            // Playful has no description — nothing else should render for it
        });

        it('applies className to the grid wrapper', () => {
            const { container } = render(
                <ChoiceBox options={TONE_OPTIONS} className="grid-cols-3 custom" />,
            );
            const wrapper = container.querySelector('[data-slot="choice-box"]');
            expect(wrapper?.classList.contains('grid-cols-3')).toBe(true);
            expect(wrapper?.classList.contains('custom')).toBe(true);
        });

        it('applies cardClassName to each option card', () => {
            const { container } = render(
                <ChoiceBox options={TONE_OPTIONS} cardClassName="my-card" />,
            );
            const cards = container.querySelectorAll('[data-slot="choice-box-card"]');
            cards.forEach((c) => expect(c.classList.contains('my-card')).toBe(true));
        });
    });

    describe('single mode — uncontrolled', () => {
        it('starts with nothing selected by default', () => {
            render(<ChoiceBox options={TONE_OPTIONS} />);
            const radios = screen.getAllByRole('radio');
            radios.forEach((r) => expect(r).toHaveAttribute('aria-checked', 'false'));
        });

        it('starts with defaultValue selected', () => {
            render(<ChoiceBox options={TONE_OPTIONS} defaultValue="friendly" />);
            const friendly = screen.getByRole('radio', { name: /Friendly/ });
            expect(friendly).toHaveAttribute('aria-checked', 'true');
        });

        it('selects on click and deselects the previous one', () => {
            render(<ChoiceBox options={TONE_OPTIONS} defaultValue="professional" />);
            const professional = screen.getByRole('radio', { name: /Professional/ });
            const friendly = screen.getByRole('radio', { name: /Friendly/ });

            fireEvent.click(friendly);
            expect(friendly).toHaveAttribute('aria-checked', 'true');
            expect(professional).toHaveAttribute('aria-checked', 'false');
        });

        it('fires onValueChange with the new string value', () => {
            const onChange = vi.fn();
            render(<ChoiceBox options={TONE_OPTIONS} onValueChange={onChange} />);
            fireEvent.click(screen.getByRole('radio', { name: /Playful/ }));
            expect(onChange).toHaveBeenCalledWith('playful');
        });
    });

    describe('single mode — controlled', () => {
        it('reflects the value prop', () => {
            const { rerender } = render(
                <ChoiceBox options={TONE_OPTIONS} value="professional" onValueChange={() => {}} />,
            );
            expect(screen.getByRole('radio', { name: /Professional/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );

            rerender(
                <ChoiceBox options={TONE_OPTIONS} value="friendly" onValueChange={() => {}} />,
            );
            expect(screen.getByRole('radio', { name: /Friendly/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
        });

        it('does not self-update — parent drives state', () => {
            render(
                <ChoiceBox options={TONE_OPTIONS} value="professional" onValueChange={() => {}} />,
            );
            const friendly = screen.getByRole('radio', { name: /Friendly/ });
            fireEvent.click(friendly);
            // Parent never updated `value`, so DOM state must not change
            expect(friendly).toHaveAttribute('aria-checked', 'false');
        });
    });

    describe('multi mode — uncontrolled', () => {
        it('renders checkbox role for each option', () => {
            render(<ChoiceBox mode="multi" options={CHANNEL_OPTIONS} />);
            expect(screen.getAllByRole('checkbox')).toHaveLength(3);
        });

        it('starts with defaultValue selected', () => {
            render(
                <ChoiceBox mode="multi" options={CHANNEL_OPTIONS} defaultValue={['email', 'push']} />,
            );
            expect(screen.getByRole('checkbox', { name: /Email/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
            expect(screen.getByRole('checkbox', { name: /Slack/ })).toHaveAttribute(
                'aria-checked',
                'false',
            );
            expect(screen.getByRole('checkbox', { name: /Push/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
        });

        it('toggles individual options on click (adds)', () => {
            render(<ChoiceBox mode="multi" options={CHANNEL_OPTIONS} />);
            fireEvent.click(screen.getByRole('checkbox', { name: /Email/ }));
            fireEvent.click(screen.getByRole('checkbox', { name: /Slack/ }));
            expect(screen.getByRole('checkbox', { name: /Email/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
            expect(screen.getByRole('checkbox', { name: /Slack/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
        });

        it('toggles individual options on click (removes)', () => {
            render(
                <ChoiceBox mode="multi" options={CHANNEL_OPTIONS} defaultValue={['email', 'slack']} />,
            );
            fireEvent.click(screen.getByRole('checkbox', { name: /Email/ }));
            expect(screen.getByRole('checkbox', { name: /Email/ })).toHaveAttribute(
                'aria-checked',
                'false',
            );
            expect(screen.getByRole('checkbox', { name: /Slack/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
        });

        it('fires onValueChange with the updated string[] value', () => {
            const onChange = vi.fn();
            render(<ChoiceBox mode="multi" options={CHANNEL_OPTIONS} onValueChange={onChange} />);
            fireEvent.click(screen.getByRole('checkbox', { name: /Email/ }));
            expect(onChange).toHaveBeenCalledWith(['email']);
            fireEvent.click(screen.getByRole('checkbox', { name: /Slack/ }));
            expect(onChange).toHaveBeenLastCalledWith(['email', 'slack']);
        });
    });

    describe('multi mode — controlled', () => {
        it('reflects the value prop', () => {
            render(
                <ChoiceBox
                    mode="multi"
                    options={CHANNEL_OPTIONS}
                    value={['email']}
                    onValueChange={() => {}}
                />,
            );
            expect(screen.getByRole('checkbox', { name: /Email/ })).toHaveAttribute(
                'aria-checked',
                'true',
            );
            expect(screen.getByRole('checkbox', { name: /Slack/ })).toHaveAttribute(
                'aria-checked',
                'false',
            );
        });

        it('calls onValueChange with the expected next state on toggle', () => {
            const onChange = vi.fn();
            render(
                <ChoiceBox
                    mode="multi"
                    options={CHANNEL_OPTIONS}
                    value={['email']}
                    onValueChange={onChange}
                />,
            );
            fireEvent.click(screen.getByRole('checkbox', { name: /Slack/ }));
            expect(onChange).toHaveBeenCalledWith(['email', 'slack']);
        });
    });

    describe('disabled', () => {
        it('marks every option aria-disabled when disabled is set on the container', () => {
            render(<ChoiceBox options={TONE_OPTIONS} disabled />);
            screen
                .getAllByRole('radio')
                .forEach((r) => expect(r).toHaveAttribute('aria-disabled', 'true'));
        });

        it('marks only options with option.disabled = true', () => {
            render(
                <ChoiceBox
                    options={[
                        { title: 'A', value: 'a', disabled: true },
                        { title: 'B', value: 'b' },
                    ]}
                />,
            );
            expect(screen.getByRole('radio', { name: /A/ })).toHaveAttribute(
                'aria-disabled',
                'true',
            );
            expect(screen.getByRole('radio', { name: /B/ })).not.toHaveAttribute(
                'aria-disabled',
            );
        });

        it('removes the disabled option from tab order (tabIndex=-1)', () => {
            render(
                <ChoiceBox
                    options={[
                        { title: 'A', value: 'a', disabled: true },
                        { title: 'B', value: 'b' },
                    ]}
                />,
            );
            expect(screen.getByRole('radio', { name: /A/ })).toHaveAttribute('tabindex', '-1');
            expect(screen.getByRole('radio', { name: /B/ })).toHaveAttribute('tabindex', '0');
        });

        it('does not fire onValueChange when disabled option is clicked', () => {
            const onChange = vi.fn();
            render(
                <ChoiceBox
                    options={[{ title: 'A', value: 'a', disabled: true }]}
                    onValueChange={onChange}
                />,
            );
            fireEvent.click(screen.getByRole('radio', { name: /A/ }));
            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('keyboard', () => {
        it('toggles on Space key', () => {
            const onChange = vi.fn();
            render(<ChoiceBox options={TONE_OPTIONS} onValueChange={onChange} />);
            fireEvent.keyDown(screen.getByRole('radio', { name: /Friendly/ }), { key: ' ' });
            expect(onChange).toHaveBeenCalledWith('friendly');
        });

        it('toggles on Enter key', () => {
            const onChange = vi.fn();
            render(<ChoiceBox options={TONE_OPTIONS} onValueChange={onChange} />);
            fireEvent.keyDown(screen.getByRole('radio', { name: /Playful/ }), { key: 'Enter' });
            expect(onChange).toHaveBeenCalledWith('playful');
        });
    });

    describe('error', () => {
        it('paints destructive border on each card when error is truthy', () => {
            const { container } = render(
                <ChoiceBox
                    options={TONE_OPTIONS}
                    error={{ message: 'Required', type: 'required', ref: null }}
                />,
            );
            const cards = container.querySelectorAll('[data-slot="choice-box-card"]');
            cards.forEach((c) => expect(c.className).toContain('ring-destructive'));
        });

        it('sets aria-invalid on the wrapper when error is truthy', () => {
            const { container } = render(
                <ChoiceBox options={TONE_OPTIONS} error={{ message: 'x', type: 'x', ref: null }} />,
            );
            expect(container.querySelector('[data-slot="choice-box"]')).toHaveAttribute(
                'aria-invalid',
                'true',
            );
        });
    });

    describe('form integration (via <Form>)', () => {
        it('single mode submits a string value under the name key', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({
                tone: z.enum(['professional', 'friendly', 'playful']),
            });

            render(
                <Form
                    schema={schema}
                    defaultValues={{ tone: 'professional' }}
                    onSubmit={onSubmit}
                >
                    <ChoiceBox name="tone" options={TONE_OPTIONS} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenCalledWith({ tone: 'professional' }),
            );

            fireEvent.click(screen.getByRole('radio', { name: /Friendly/ }));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenLastCalledWith({ tone: 'friendly' }),
            );
        });

        it('multi mode submits a string[] value under the name key', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({
                channels: z.array(z.string()),
            });

            render(
                <Form schema={schema} defaultValues={{ channels: [] }} onSubmit={onSubmit}>
                    <ChoiceBox name="channels" mode="multi" options={CHANNEL_OPTIONS} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByRole('checkbox', { name: /Email/ }));
            fireEvent.click(screen.getByRole('checkbox', { name: /Push/ }));
            fireEvent.click(screen.getByText('Submit'));

            await waitFor(() =>
                expect(onSubmit).toHaveBeenCalledWith({ channels: ['email', 'push'] }),
            );
        });

        it('paints destructive border when zod validation fails', async () => {
            const schema = z.object({
                channels: z.array(z.string()).min(1, { message: 'Pick one' }),
            });

            const { container } = render(
                <Form schema={schema} defaultValues={{ channels: [] }} onSubmit={() => {}}>
                    <ChoiceBox name="channels" mode="multi" options={CHANNEL_OPTIONS} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const cards = container.querySelectorAll('[data-slot="choice-box-card"]');
                cards.forEach((c) => expect(c.className).toContain('ring-destructive'));
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ tone: z.string() });
            render(
                <Form schema={schema} defaultValues={{ tone: 'professional' }} pending onSubmit={() => {}}>
                    <ChoiceBox name="tone" options={TONE_OPTIONS} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            screen
                .getAllByRole('radio')
                .forEach((r) => expect(r).toHaveAttribute('aria-disabled', 'true'));
        });
    });

    describe('indicator', () => {
        it('renders a radio indicator in single mode', () => {
            const { container } = render(
                <ChoiceBox options={TONE_OPTIONS} defaultValue="professional" />,
            );
            const card = container.querySelector('[data-value="professional"]') as HTMLElement;
            expect(card).toHaveAttribute('role', 'radio');
            expect(
                card.querySelector('[data-slot="choice-box-radio-indicator"]'),
            ).toBeInTheDocument();
        });

        it('renders a checkbox indicator in multi mode with the same data-state contract as <Checkbox>', () => {
            const { container } = render(
                <ChoiceBox mode="multi" options={CHANNEL_OPTIONS} defaultValue={['email']} />,
            );
            const card = container.querySelector('[data-value="email"]') as HTMLElement;
            expect(card).toHaveAttribute('role', 'checkbox');
            const indicator = card.querySelector(
                '[data-slot="choice-box-checkbox-indicator"]',
            ) as HTMLElement;
            expect(indicator).toBeInTheDocument();
            // Mirrors the data-state styling hook used by the Checkbox component.
            expect(indicator).toHaveAttribute('data-state', 'checked');
        });

        it('indicator slot is the same fixed size in both modes so titles line up', () => {
            const { container: singleContainer } = render(
                <ChoiceBox options={TONE_OPTIONS} />,
            );
            const { container: multiContainer } = render(
                <ChoiceBox mode="multi" options={CHANNEL_OPTIONS} />,
            );

            const singleSlot = singleContainer.querySelector(
                '[data-slot="choice-box-indicator-slot"]',
            ) as HTMLElement;
            const multiSlot = multiContainer.querySelector(
                '[data-slot="choice-box-indicator-slot"]',
            ) as HTMLElement;

            // Same wrapper className → same box dimensions → the title column starts at the same X.
            expect(singleSlot.className).toBe(multiSlot.className);
        });
    });
});
