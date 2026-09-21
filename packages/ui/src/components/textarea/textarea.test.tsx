/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Textarea } from './textarea.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

describe('Textarea', () => {
    describe('rendering', () => {
        it('renders with the provided label', () => {
            render(<Textarea label="Bio" />);
            expect(screen.getByText('Bio')).toBeInTheDocument();
        });

        it('omits the label wrapper when no label is provided', () => {
            const { container } = render(<Textarea />);
            expect(container.querySelector('label')).toBeNull();
        });

        it('renders the error message under the textarea', () => {
            const error = { message: 'Required', type: 'required', ref: null };
            render(<Textarea label="Bio" error={error} />);
            expect(screen.getByText('Required')).toBeInTheDocument();
        });

        it('applies destructive border when error is truthy', () => {
            const error = { message: 'bad', type: 'validate', ref: null };
            const { container } = render(<Textarea error={error} />);
            const ta = container.querySelector('[data-slot="textarea"]') as HTMLElement;
            expect(ta.className).toContain('border-destructive');
        });

        it('forwards className to the textarea element', () => {
            const { container } = render(<Textarea className="min-h-32" />);
            const ta = container.querySelector('[data-slot="textarea"]') as HTMLElement;
            expect(ta.className).toContain('min-h-32');
        });
    });

    describe('uncontrolled', () => {
        it('starts with defaultValue and accepts typing', () => {
            render(<Textarea defaultValue="seed" aria-label="bio" />);
            const ta = screen.getByLabelText('bio') as HTMLTextAreaElement;
            expect(ta.value).toBe('seed');
            fireEvent.change(ta, { target: { value: 'seed more' } });
            expect(ta.value).toBe('seed more');
        });

        it('starts empty when no defaultValue is provided', () => {
            render(<Textarea aria-label="bio" />);
            const ta = screen.getByLabelText('bio') as HTMLTextAreaElement;
            expect(ta.value).toBe('');
        });
    });

    describe('controlled', () => {
        it('reflects the value prop', () => {
            const { rerender } = render(<Textarea value="a" onChange={() => {}} aria-label="bio" />);
            expect((screen.getByLabelText('bio') as HTMLTextAreaElement).value).toBe('a');
            rerender(<Textarea value="ab" onChange={() => {}} aria-label="bio" />);
            expect((screen.getByLabelText('bio') as HTMLTextAreaElement).value).toBe('ab');
        });

        it('does not self-update — parent drives state via onChange', () => {
            render(<Textarea value="" onChange={() => {}} aria-label="bio" />);
            const ta = screen.getByLabelText('bio') as HTMLTextAreaElement;
            fireEvent.change(ta, { target: { value: 'x' } });
            // Parent never updated `value`, so the DOM must still show empty
            expect(ta.value).toBe('');
        });

        it('fires onChange on user input', () => {
            const onChange = vi.fn();
            render(<Textarea value="" onChange={onChange} aria-label="bio" />);
            fireEvent.change(screen.getByLabelText('bio'), { target: { value: 'hi' } });
            expect(onChange).toHaveBeenCalled();
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits a string payload under the textarea name', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ bio: z.string() });

            render(
                <Form schema={schema} defaultValues={{ bio: 'hello' }} onSubmit={onSubmit}>
                    <Textarea name="bio" label="Bio" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ bio: 'hello' }));

            const ta = screen.getByLabelText('Bio') as HTMLTextAreaElement;
            fireEvent.change(ta, { target: { value: 'updated' } });
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ bio: 'updated' }));
        });

        it('paints destructive border when zod validation fails on submit', async () => {
            const schema = z.object({
                bio: z.string().min(10, { message: 'Too short' }),
            });
            // Stable reference — Form runs `reset(defaultValues)` in a useEffect keyed on
            // `defaultValues`, so an inline object here would re-fire reset on every render
            // and wipe the error state RHF just wrote.
            const defaults = { bio: 'hi' };

            const { container } = render(
                <Form schema={schema} defaultValues={defaults} onSubmit={() => {}}>
                    <Textarea name="bio" label="Bio" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                expect(screen.getByText('Too short')).toBeInTheDocument();
            });
            const ta = container.querySelector('[data-slot="textarea"]') as HTMLElement;
            expect(ta.className).toContain('border-destructive');
        });

        it('stays controlled (no warning) when defaultValues has no entry for the field', () => {
            // No `bio` in defaultValues — the form branch must coerce undefined → ''
            // to prevent React's controlled/uncontrolled warning on first keystroke.
            const schema = z.object({ bio: z.string() });
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            render(
                <Form schema={schema} defaultValues={{}} onSubmit={() => {}}>
                    <Textarea name="bio" label="Bio" />
                </Form>,
            );
            const ta = screen.getByLabelText('Bio') as HTMLTextAreaElement;
            expect(ta.value).toBe('');
            fireEvent.change(ta, { target: { value: 'typing' } });
            // No controlled/uncontrolled warning should fire.
            const warned = spy.mock.calls.some((args) =>
                String(args[0] ?? '').includes('controlled'),
            );
            expect(warned).toBe(false);
            spy.mockRestore();
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ bio: z.string() });
            render(
                <Form schema={schema} defaultValues={{ bio: 'x' }} pending onSubmit={() => {}}>
                    <Textarea name="bio" label="Bio" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            expect(screen.getByLabelText('Bio')).toBeDisabled();
        });
    });
});
