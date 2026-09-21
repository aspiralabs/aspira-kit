/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Button } from '../button/index.js';
import { Input } from '../input/index.js';
import { InputAddress } from '../input-address/index.js';
import { Textarea } from '../textarea/index.js';
import { Form } from './form.js';

// A childless component the walker cannot bind; it reaches the form through context.
function ContextProbe() {
    const form = useFormContext();
    const state = form ? 'has-context' : 'no-context';
    return <span data-testid="probe">{state}</span>;
}

describe('Form', () => {
    describe('form context', () => {
        it('exposes react-hook-form context to nested components', () => {
            const schema = z.object({ name: z.string() });
            render(
                <Form schema={schema} onSubmit={vi.fn()}>
                    <ContextProbe />
                </Form>,
            );
            expect(screen.getByTestId('probe')).toHaveTextContent('has-context');
        });

        it('lets a nested component set a field programmatically and submits it', async () => {
            const schema = z.object({ city: z.string() });
            const onSubmit = vi.fn();
            function Setter() {
                const { setValue } = useFormContext();
                return (
                    <button type="button" onClick={() => setValue('city', 'Austin')}>
                        set city
                    </button>
                );
            }
            render(
                <Form schema={schema} defaultValues={{ city: '' }} onSubmit={onSubmit}>
                    <Input name="city" label="City" />
                    <Setter />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            fireEvent.click(screen.getByText('set city'));
            // The Input binding feeds the RHF value back, so the field shows the programmatic value.
            await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Austin'));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ city: 'Austin' }));
        });
    });

    describe('unnamed Textarea', () => {
        it('renders an unnamed Textarea as-is instead of binding it', async () => {
            const schema = z.object({ bio: z.string() });
            const onSubmit = vi.fn();
            const onNote = vi.fn();
            render(
                <Form schema={schema} defaultValues={{ bio: 'x' }} onSubmit={onSubmit}>
                    <Textarea name="bio" label="Bio" />
                    <Textarea label="Note" onChange={(e) => onNote(e.target.value)} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
            fireEvent.change(note, { target: { value: 'scratch' } });
            expect(onNote).toHaveBeenCalledWith('scratch');
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ bio: 'x' }));
        });
    });

    describe('InputAddress binding', () => {
        it('binds the street field and fills siblings on pick', async () => {
            const schema = z.object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() });
            const onSubmit = vi.fn();
            const feature = {
                place_name: '1 Main St, Austin, Texas 78701, United States',
                text: 'Main St',
                address: '1',
                center: [-97.7, 30.3],
                context: [
                    { id: 'postcode.1', text: '78701' },
                    { id: 'place.1', text: 'Austin' },
                    { id: 'region.1', text: 'Texas', short_code: 'US-TX' },
                ],
            };
            const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [feature] }) }));
            vi.stubGlobal('fetch', fetchMock);
            vi.useFakeTimers({ shouldAdvanceTime: true });

            const { container } = render(
                <Form schema={schema} defaultValues={{ street: '', city: '', state: '', zip: '' }} onSubmit={onSubmit}>
                    <InputAddress name="street" label="Street" token="t" cityField="city" stateField="state" zipField="zip" />
                    <Input name="city" label="City" />
                    <Input name="state" label="State" />
                    <Input name="zip" label="ZIP" />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            const street = container.querySelector('input[placeholder^="Start typing"]') as HTMLInputElement;
            fireEvent.input(street, { target: { value: '1 Mai' } });
            await act(() => vi.advanceTimersByTimeAsync(300));
            await waitFor(() => expect(fetchMock).toHaveBeenCalled());
            const option = await screen.findByText(feature.place_name);
            fireEvent.click(option);

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenCalledWith({ street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }),
            );
            vi.useRealTimers();
            vi.unstubAllGlobals();
        });
    });
});
