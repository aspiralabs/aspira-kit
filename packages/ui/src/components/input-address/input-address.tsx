'use client';

import * as React from 'react';
import { useFormContext } from 'react-hook-form';

import { cn } from '../../lib/cn.js';
import { Input } from '../input/index.js';
import { Icon } from '../icon/index.js';
import { FormError } from '../form/index.js';
import { floatingPanelClassName, floatingItemClassName } from '../../primitives/floating-panel-primitive.js';

/**
 * InputAddress — a street-address field that extends {@link Input} with Mapbox
 * autocomplete. As the user types it queries the Mapbox Geocoding API and shows
 * matching addresses; picking one fills the street field and (via
 * `useFormContext`) the sibling city / state / zip / lat / lng fields in one go.
 *
 * The Mapbox public token comes in as the `token` prop (the package reads no
 * environment). Without a token the field degrades to a plain text input with
 * no suggestions, so a form still works offline or before the token is wired.
 *
 * Display is driven through the inner Input's `defaultValue` (the imask re-sync
 * contract), but only a pick or an external reset changes it. Typed text is never
 * written back into the mask: a write that lands while the user is mid-keystroke
 * clobbers the newer DOM value, and the two values then echo each other through
 * the mask with no fixed point (a render loop).
 *
 * Ported from PET_WASTE_CRM on 2026-09-19.
 */

export interface AddressParts {
    streetAddress: string;
    city: string;
    state: string;
    zip: string;
    lat: number | null;
    lng: number | null;
    placeName: string;
}

interface MapboxContextEntry {
    id: string;
    text: string;
    short_code?: string;
}

interface MapboxFeature {
    place_name?: string;
    text?: string;
    address?: string;
    center?: [number, number];
    context?: MapboxContextEntry[];
}

interface InputAddressProps {
    name?: string;
    label?: string;
    placeholder?: string;
    /** Street string — Form/RHF wires `{ value, onChange }` for the street field. */
    value?: string;
    onChange?: (value: string) => void;
    onBlur?: () => void;
    disabled?: boolean;
    error?: FormError;
    size?: 'default' | 'sm' | 'xs';
    className?: string;
    /** Mapbox public access token. Omit to disable suggestions. */
    token?: string;
    /** ISO 3166-1 country filter for suggestions. Default `'us'`. */
    country?: string;
    /** Sibling RHF field names to autofill from the picked address. */
    cityField?: string;
    stateField?: string;
    zipField?: string;
    latField?: string;
    lngField?: string;
    /** Fires with the fully-parsed address whenever a suggestion is picked. */
    onAddressSelect?: (parts: AddressParts) => void;
    /**
     * Show the full "street, city, ST zip" in the field after a pick, instead of
     * just the street line. The emitted form value stays street-only either way —
     * this only changes the displayed text. Use when city/state/zip are NOT shown
     * as separate fields (e.g. a compact onboarding form).
     */
    showFullAddress?: boolean;
}

const GEOCODE_ENDPOINT = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

// Match the dropdown text to the input's own font size.
const ITEM_TEXT = { default: 'text-base', sm: 'text-sm', xs: 'text-xs' } as const;

/**
 * Whether an inner-Input value change should query Mapbox. Pure so it can be
 * unit-tested without rendering. Guards two non-typing sources of onValueChange:
 *  - `isPickEcho` — the mask echoing the display we seeded after a suggestion pick.
 *  - `next === prev` — the imask re-sync echoes the current value on mount and on
 *    programmatic (reset/prefill) updates; a prefilled address must NOT pop the
 *    suggestion dropdown open the moment the form loads.
 */
export function shouldQueryOnChange(next: string, prev: string, isPickEcho: boolean): boolean {
    if (isPickEcho) return false;
    return next !== prev;
}

/** Pull `{ street, city, state, zip, lat, lng }` out of a Mapbox `address` feature. */
export function parseFeature(feature: MapboxFeature): AddressParts {
    const houseNumber = feature.address?.trim();
    const streetName = feature.text?.trim() ?? '';
    const streetAddress = [houseNumber, streetName].filter(Boolean).join(' ');

    let city = '';
    let state = '';
    let zip = '';

    for (const entry of feature.context ?? []) {
        const kind = entry.id.split('.')[0];
        if ((kind === 'place' || kind === 'locality') && !city) {
            city = entry.text;
        } else if (kind === 'region' && !state) {
            // short_code is like `US-TX` — take the trailing state code.
            const code = entry.short_code?.split('-')[1];
            state = code ? code.toUpperCase() : entry.text;
        } else if (kind === 'postcode' && !zip) {
            zip = entry.text;
        }
    }

    const center = feature.center;
    const lng = center && typeof center[0] === 'number' ? center[0] : null;
    const lat = center && typeof center[1] === 'number' ? center[1] : null;

    return {
        streetAddress,
        city,
        state,
        zip,
        lat,
        lng,
        placeName: feature.place_name ?? streetAddress,
    };
}

/** Compose a single-line "street, city, ST zip" from parsed parts (parts absent
 *  from the geocode are simply skipped). Pure, so it's unit-testable. */
export function formatFullAddress(parts: AddressParts): string {
    const head = [parts.streetAddress, parts.city].filter(Boolean).join(', ');
    const stateZip = [parts.state, parts.zip].filter(Boolean).join(' ');
    return [head, stateZip].filter(Boolean).join(', ');
}

function InputAddress({
    name,
    label,
    placeholder = 'Start typing an address…',
    value,
    onChange,
    onBlur,
    disabled,
    error,
    size = 'default',
    className,
    token,
    country = 'us',
    cityField,
    stateField,
    zipField,
    latField,
    lngField,
    onAddressSelect,
    showFullAddress = false,
}: InputAddressProps) {
    // Optional: only present when rendered inside a <Form>/FormProvider. Guarded
    // everywhere so InputAddress also works as a standalone controlled input.
    const form = useFormContext();
    const hasToken = Boolean(token && token.trim().length > 0);
    const itemTextClass = ITEM_TEXT[size];

    // Seed fed to the inner Input via its `defaultValue` re-sync contract. Changes
    // only on a pick or an external reset, never on typing (see the note above).
    // `seedKey` remounts the Input when a pick re-seeds the same string the seed
    // already holds (pick, edit, pick the same again), which `defaultValue` alone
    // would not re-apply.
    const [seed, setSeed] = React.useState<string>(value ?? '');
    const [seedKey, setSeedKey] = React.useState(0);
    const lastEmittedRef = React.useRef<string>(value ?? '');

    const reseed = (next: string) => {
        if (next === seed) setSeedKey((k) => k + 1);
        setSeed(next);
    };

    const [suggestions, setSuggestions] = React.useState<MapboxFeature[]>([]);
    const [open, setOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(false);

    const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = React.useRef<AbortController | null>(null);
    // The display text we seeded on the last pick. The mask echoes it back through
    // onValueChange; that echo must neither fetch nor emit (with `showFullAddress`
    // the display is not the street value). Compared by content rather than a
    // one-shot flag: when the seed equals what the mask already holds there is no
    // echo at all, and a flag would swallow the next real keystroke.
    const pickedDisplayRef = React.useRef<string | null>(null);

    // Re-sync the display when the RHF value changes from the outside (reset,
    // programmatic set) and differs from what we last emitted.
    React.useEffect(() => {
        const next = value ?? '';
        if (next !== lastEmittedRef.current) {
            lastEmittedRef.current = next;
            setSeed(next);
        }
    }, [value]);

    React.useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            abortRef.current?.abort();
        };
    }, []);

    const fetchSuggestions = React.useCallback(
        (query: string) => {
            if (!hasToken || query.trim().length < 3) {
                setSuggestions([]);
                setOpen(false);
                return;
            }

            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setLoading(true);

            const url =
                `${GEOCODE_ENDPOINT}/${encodeURIComponent(query)}.json` +
                `?access_token=${encodeURIComponent(token as string)}` +
                `&autocomplete=true&types=address&country=${encodeURIComponent(country)}&limit=5`;

            fetch(url, { signal: controller.signal })
                .then((res) => (res.ok ? res.json() : Promise.reject(new Error('geocode failed'))))
                .then((data: { features?: MapboxFeature[] }) => {
                    const features = data.features ?? [];
                    setSuggestions(features);
                    setOpen(features.length > 0);
                })
                .catch((err) => {
                    if ((err as Error).name === 'AbortError') return;
                    setSuggestions([]);
                    setOpen(false);
                })
                .finally(() => setLoading(false));
        },
        [hasToken, token, country],
    );

    const emit = (next: string) => {
        lastEmittedRef.current = next;
        onChange?.(next);
    };

    const handleInputChange = ({ value: nextString }: { value: string; typedValue: unknown }) => {
        // Capture what we last emitted BEFORE emit() overwrites it, so we can tell
        // real user edits from mount/reset echoes.
        const prev = lastEmittedRef.current;
        const isPickEcho = nextString === pickedDisplayRef.current;
        if (!isPickEcho) {
            pickedDisplayRef.current = null;
            emit(nextString);
        }
        if (!shouldQueryOnChange(nextString, prev, isPickEcho)) return;

        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchSuggestions(nextString), 250);
    };

    const handleSelect = (feature: MapboxFeature) => {
        const parts = parseFeature(feature);

        // Display can be the full address; the form value stays street-only so the
        // sibling city/state/zip fields aren't duplicated into it. The value-sync
        // effect won't clobber this — `emit` leaves lastEmittedRef === form value.
        const display = showFullAddress ? formatFullAddress(parts) : parts.streetAddress;
        pickedDisplayRef.current = display;
        reseed(display);
        emit(parts.streetAddress);

        // Fill the sibling fields when wired to a form. `shouldValidate` clears any
        // pre-existing required errors on those fields.
        if (form) {
            const opts = { shouldValidate: true, shouldDirty: true } as const;
            if (cityField) form.setValue(cityField, parts.city, opts);
            if (stateField) form.setValue(stateField, parts.state, opts);
            if (zipField) form.setValue(zipField, parts.zip, opts);
            if (latField) form.setValue(latField, parts.lat ?? undefined, opts);
            if (lngField) form.setValue(lngField, parts.lng ?? undefined, opts);
        }

        onAddressSelect?.(parts);

        setSuggestions([]);
        setOpen(false);
    };

    const showSearching = loading && suggestions.length === 0;

    return (
        <div
            className={cn('relative', className)}
            // Close the dropdown when focus leaves the whole widget (input + list).
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setOpen(false);
                    onBlur?.();
                }
            }}
        >
            <Input
                key={seedKey}
                name={name}
                label={label}
                placeholder={placeholder}
                defaultValue={seed}
                onValueChange={handleInputChange}
                disabled={disabled}
                error={error}
                size={size}
                icon="location_on"
                autoComplete="off"
                onFocus={() => {
                    if (suggestions.length > 0) setOpen(true);
                }}
            />

            {open && (
                <ul
                    role="listbox"
                    className={cn(floatingPanelClassName, 'absolute mt-1 w-full max-h-64 overflow-auto p-1')}
                >
                    {showSearching && (
                        <li className={cn('flex items-center gap-2 px-3 h-10 text-foreground-subtext', itemTextClass)}>
                            <Icon icon="progress_activity" size={16} className="animate-spin" />
                            Searching…
                        </li>
                    )}
                    {suggestions.map((feature, i) => (
                        <li key={feature.place_name ?? i} role="option" aria-selected={false}>
                            <button
                                type="button"
                                // Keep focus inside the widget so the onBlur guard
                                // doesn't close the list before the click lands.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => handleSelect(feature)}
                                className={cn(
                                    floatingItemClassName,
                                    // Dark-mode highlight parity with SelectItemPrimitive
                                    // (floatingItemClassName's hover:bg-surface reads light in dark).
                                    'w-full px-3 text-left transition',
                                    'dark:hover:bg-gray-arsenic dark:focus:bg-gray-arsenic focus:text-foreground',
                                    itemTextClass,
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate">{feature.place_name}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

InputAddress.displayName = 'InputAddress';

export { InputAddress };
export type { InputAddressProps };
