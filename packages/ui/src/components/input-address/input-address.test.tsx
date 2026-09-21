/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InputAddress, formatFullAddress, parseFeature, shouldQueryOnChange } from './input-address.js';

describe('formatFullAddress — single-line display', () => {
    it('composes "street, city, ST zip"', () => {
        expect(
            formatFullAddress({
                streetAddress: '1271 Patterson Terrace',
                city: 'Springfield',
                state: 'IL',
                zip: '62704',
                lat: 0,
                lng: 0,
                placeName: '',
            }),
        ).toBe('1271 Patterson Terrace, Springfield, IL 62704');
    });

    it('skips parts the geocode did not return', () => {
        expect(
            formatFullAddress({
                streetAddress: '1271 Patterson Terrace',
                city: '',
                state: '',
                zip: '',
                lat: null,
                lng: null,
                placeName: '',
            }),
        ).toBe('1271 Patterson Terrace');
    });
});

describe('shouldQueryOnChange — Mapbox fetch gating', () => {
    it('queries when the user types a genuinely new value', () => {
        expect(shouldQueryOnChange('123 Main', '123 Mai', false)).toBe(true);
    });

    it('does NOT query when the value is unchanged (mount/reset echo)', () => {
        // The prefill bug: imask echoes the current value on mount with next === prev.
        expect(shouldQueryOnChange('4448 Lipton Court', '4448 Lipton Court', false)).toBe(false);
    });

    it('does NOT query right after a programmatic suggestion pick', () => {
        expect(shouldQueryOnChange('123 Main St', '123 Main', true)).toBe(false);
    });

    it('treats empty→empty as no change', () => {
        expect(shouldQueryOnChange('', '', false)).toBe(false);
    });

    it('queries when clearing a prefilled value (real edit to empty)', () => {
        expect(shouldQueryOnChange('', '4448 Lipton Court', false)).toBe(true);
    });
});

describe('parseFeature — Mapbox address feature parsing', () => {
    const feature = {
        place_name: '4448 Lipton Court, Orlando, Florida 32817, United States',
        text: 'Lipton Court',
        address: '4448',
        center: [-81.2, 28.5] as [number, number],
        context: [
            { id: 'postcode.123', text: '32817' },
            { id: 'place.456', text: 'Orlando' },
            { id: 'region.789', text: 'Florida', short_code: 'US-FL' },
            { id: 'country.0', text: 'United States', short_code: 'us' },
        ],
    };

    it('joins house number + street into the street address', () => {
        expect(parseFeature(feature).streetAddress).toBe('4448 Lipton Court');
    });

    it('extracts city, state code, and zip from context', () => {
        const parts = parseFeature(feature);
        expect(parts.city).toBe('Orlando');
        expect(parts.state).toBe('FL'); // trailing code from `US-FL`, uppercased
        expect(parts.zip).toBe('32817');
    });

    it('maps center [lng, lat] to lat/lng', () => {
        const parts = parseFeature(feature);
        expect(parts.lng).toBe(-81.2);
        expect(parts.lat).toBe(28.5);
    });

    it('keeps the full place_name', () => {
        expect(parseFeature(feature).placeName).toBe(
            '4448 Lipton Court, Orlando, Florida 32817, United States',
        );
    });

    it('falls back to null coords and street-only placeName when center/context are missing', () => {
        const parts = parseFeature({ text: 'Main St', address: '10' });
        expect(parts.lat).toBeNull();
        expect(parts.lng).toBeNull();
        expect(parts.city).toBe('');
        expect(parts.state).toBe('');
        expect(parts.zip).toBe('');
        expect(parts.placeName).toBe('10 Main St');
    });

    it('uses region text when no short_code is present', () => {
        const parts = parseFeature({
            text: 'Elm St',
            address: '5',
            context: [{ id: 'region.1', text: 'Ontario' }],
        });
        expect(parts.state).toBe('Ontario');
    });
});

const FEATURE = {
    place_name: '1 Main St, Austin, Texas 78701, United States',
    text: 'Main St',
    address: '1',
    center: [-97.7, 30.3] as [number, number],
    context: [
        { id: 'postcode.1', text: '78701' },
        { id: 'place.1', text: 'Austin' },
        { id: 'region.1', text: 'Texas', short_code: 'US-TX' },
    ],
};

function streetInput() {
    return document.querySelector('input[placeholder^="Start typing"]') as HTMLInputElement;
}

describe('InputAddress (component)', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [FEATURE] }) }));

    beforeEach(() => {
        fetchMock.mockClear();
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('is a plain text input without a token: emits edits, never fetches', async () => {
        const onChange = vi.fn();
        render(<InputAddress value="" onChange={onChange} />);
        fireEvent.input(streetInput(), { target: { value: '123 Main' } });
        await vi.advanceTimersByTimeAsync(400);
        expect(onChange).toHaveBeenLastCalledWith('123 Main');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('debounces a geocode request with the token and country and shows suggestions', async () => {
        render(<InputAddress token="tok" country="ca" value="" onChange={vi.fn()} />);
        fireEvent.input(streetInput(), { target: { value: '1 Ma' } });
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
        expect(url).toContain('access_token=tok');
        expect(url).toContain('country=ca');
        expect(url).toContain('1%20Ma');
        expect(await screen.findByText(FEATURE.place_name)).toBeInTheDocument();
    });

    it('does not query for fewer than three characters', async () => {
        render(<InputAddress token="tok" value="" onChange={vi.fn()} />);
        fireEvent.input(streetInput(), { target: { value: '12' } });
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not open suggestions for a prefilled or reset value', async () => {
        function Parent() {
            const [v, setV] = useState('1 Main St');
            return (
                <>
                    <InputAddress token="tok" value={v} onChange={setV} />
                    <button type="button" onClick={() => setV('9 Other Rd')}>
                        reset
                    </button>
                </>
            );
        }
        render(<Parent />);
        await vi.advanceTimersByTimeAsync(400);
        fireEvent.click(screen.getByText('reset'));
        await vi.advanceTimersByTimeAsync(400);
        await waitFor(() => expect(streetInput().value).toBe('9 Other Rd'));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('emits only the street on pick, reports the parsed parts, and closes the list', async () => {
        const onChange = vi.fn();
        const onAddressSelect = vi.fn();
        render(<InputAddress token="tok" value="" onChange={onChange} onAddressSelect={onAddressSelect} />);
        fireEvent.input(streetInput(), { target: { value: '1 Ma' } });
        await vi.advanceTimersByTimeAsync(300);
        fireEvent.click(await screen.findByText(FEATURE.place_name));
        expect(onChange).toHaveBeenLastCalledWith('1 Main St');
        expect(onAddressSelect).toHaveBeenCalledWith(
            expect.objectContaining({ streetAddress: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', lat: 30.3, lng: -97.7 }),
        );
        expect(screen.queryByRole('listbox')).toBeNull();
        await waitFor(() => expect(streetInput().value).toBe('1 Main St'));
    });

    it('showFullAddress displays the full line but still emits the street only', async () => {
        const onChange = vi.fn();
        render(<InputAddress token="tok" value="" onChange={onChange} showFullAddress />);
        fireEvent.input(streetInput(), { target: { value: '1 Ma' } });
        await vi.advanceTimersByTimeAsync(300);
        fireEvent.click(await screen.findByText(FEATURE.place_name));
        await waitFor(() => expect(streetInput().value).toBe('1 Main St, Austin, TX 78701'));
        // The mask echo of the seeded display must not be emitted as the value.
        await vi.advanceTimersByTimeAsync(50);
        expect(onChange).toHaveBeenLastCalledWith('1 Main St');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-fetch on the echo of a pick, but does on the next real edit', async () => {
        render(<InputAddress token="tok" value="" onChange={vi.fn()} />);
        fireEvent.input(streetInput(), { target: { value: '1 Ma' } });
        await vi.advanceTimersByTimeAsync(300);
        fireEvent.click(await screen.findByText(FEATURE.place_name));
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fireEvent.input(streetInput(), { target: { value: '1 Main Str' } });
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
