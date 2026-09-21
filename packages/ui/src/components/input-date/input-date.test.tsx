/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InputDate } from './input-date.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

// Typing into an imask-wrapped input requires firing on the underlying input element.
const typeInto = (el: HTMLElement, value: string) => {
    fireEvent.input(el, { target: { value } });
};

describe('InputDate', () => {
    describe('rendering', () => {
        it('renders the label', () => {
            render(<InputDate label="Birthday" />);
            expect(screen.getByText('Birthday')).toBeInTheDocument();
        });

        it('renders the placeholder = format by default', () => {
            const { container } = render(<InputDate label="Birthday" />);
            const input = container.querySelector('input') as HTMLInputElement;
            expect(input.placeholder).toBe('MM/DD/YYYY');
        });

        it('renders a calendar trigger button', () => {
            render(<InputDate label="Birthday" />);
            expect(screen.getByRole('button', { name: /Open calendar/ })).toBeInTheDocument();
        });

        it('starts empty when no value/defaultValue is provided', () => {
            const { container } = render(<InputDate label="Birthday" />);
            const input = container.querySelector('input') as HTMLInputElement;
            expect(input.value).toBe('');
        });

        it('displays the formatted defaultValue', () => {
            const { container } = render(
                <InputDate label="Birthday" defaultValue={new Date(1990, 5, 15)} />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            // dayjs formats as 06/15/1990 for month=5 (June)
            expect(input.value).toBe('06/15/1990');
        });
    });

    describe('uncontrolled', () => {
        it('emits a Date when a full valid date is typed', () => {
            const onChange = vi.fn();
            const { container } = render(
                <InputDate label="Birthday" onValueChange={onChange} />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '03/14/2021');

            // Final emission should be a Date for 2021-03-14
            const last = onChange.mock.calls.at(-1)?.[0];
            expect(last).toBeInstanceOf(Date);
            expect((last as Date).getFullYear()).toBe(2021);
            expect((last as Date).getMonth()).toBe(2); // 0-indexed
            expect((last as Date).getDate()).toBe(14);
        });

        it('does not emit a Date while the typed string is not a complete valid date', () => {
            const onChange = vi.fn();
            const { container } = render(
                <InputDate label="Birthday" onValueChange={onChange} />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '03/14/202'); // incomplete year
            // onValueChange may fire with undefined for empty/intermediate states on mount or
            // reset — what matters is that no Date instance was emitted for the partial string.
            const emittedDates = onChange.mock.calls
                .map((c) => c[0])
                .filter((v) => v instanceof Date);
            expect(emittedDates).toHaveLength(0);
        });

        it('emits undefined when the input is cleared', () => {
            const onChange = vi.fn();
            const { container } = render(
                <InputDate
                    label="Birthday"
                    defaultValue={new Date(2020, 0, 1)}
                    onValueChange={onChange}
                />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '');
            expect(onChange).toHaveBeenLastCalledWith(undefined);
        });
    });

    describe('controlled', () => {
        it('reflects the value prop', () => {
            const { container, rerender } = render(
                <InputDate
                    label="Birthday"
                    value={new Date(1990, 5, 15)}
                    onValueChange={() => {}}
                />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            expect(input.value).toBe('06/15/1990');

            rerender(
                <InputDate
                    label="Birthday"
                    value={new Date(2000, 0, 1)}
                    onValueChange={() => {}}
                />,
            );
            expect(input.value).toBe('01/01/2000');
        });

        it('calls onValueChange when a valid date is typed', () => {
            const onChange = vi.fn();
            const { container } = render(
                <InputDate
                    label="Birthday"
                    value={undefined}
                    onValueChange={onChange}
                />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '07/20/1999');
            const last = onChange.mock.calls.at(-1)?.[0];
            expect((last as Date).toISOString()).toBe(new Date(1999, 6, 20).toISOString());
        });
    });

    describe('bounds', () => {
        it('sets an out-of-range error when typed date is before fromDate', () => {
            const { container } = render(
                <InputDate
                    label="In the next 30 days"
                    fromDate={new Date(2024, 0, 1)}
                    toDate={new Date(2024, 11, 31)}
                />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '12/31/2023');
            // Input paints a destructive border + renders the error message when error prop is set.
            expect(input.className).toContain('border-destructive');
            expect(screen.getByText(/Date must be between/i)).toBeInTheDocument();
        });

        it('does not set an error for in-range dates', () => {
            const { container } = render(
                <InputDate
                    label="In the next 30 days"
                    fromDate={new Date(2024, 0, 1)}
                    toDate={new Date(2024, 11, 31)}
                />,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '06/15/2024');
            expect(input.className.split(' ')).not.toContain('border-destructive');
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits a Date payload under the name key', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ birthdate: z.date() });
            const defaults = { birthdate: new Date(1990, 5, 15) };

            const { container } = render(
                <Form schema={schema} defaultValues={defaults} onSubmit={onSubmit}>
                    <InputDate name="birthdate" label="Birthday" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            // Submit with initial default
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const first = onSubmit.mock.calls.at(0)?.[0];
                expect(first?.birthdate).toBeInstanceOf(Date);
                expect((first.birthdate as Date).getFullYear()).toBe(1990);
            });

            // Type a new date, submit again
            const input = container.querySelector('input') as HTMLInputElement;
            typeInto(input, '12/25/2000');
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const last = onSubmit.mock.calls.at(-1)?.[0];
                expect((last.birthdate as Date).getFullYear()).toBe(2000);
                expect((last.birthdate as Date).getMonth()).toBe(11);
                expect((last.birthdate as Date).getDate()).toBe(25);
            });
        });

        it('paints the Input destructive state when zod validation fails', async () => {
            const schema = z.object({
                birthdate: z.date({ error: () => 'Pick a date' }),
            });
            const defaults = { birthdate: undefined as unknown as Date };

            const { container } = render(
                <Form schema={schema} defaultValues={defaults} onSubmit={() => {}}>
                    <InputDate name="birthdate" label="Birthday" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const input = container.querySelector('input') as HTMLInputElement;
                expect(input.className).toContain('border-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ birthdate: z.date().optional() });
            const { container } = render(
                <Form
                    schema={schema}
                    defaultValues={{ birthdate: undefined }}
                    pending
                    onSubmit={() => {}}
                >
                    <InputDate name="birthdate" label="Birthday" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            const input = container.querySelector('input') as HTMLInputElement;
            expect(input).toBeDisabled();
            expect(screen.getByRole('button', { name: /Open calendar/ })).toBeDisabled();
        });
    });
});
