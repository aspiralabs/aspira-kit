import * as React from 'react';

// Registry of project-local SVG icons that the <Icon> component can render in
// place of Material Symbols. Add a new entry here and reference it by name —
// e.g. <Icon icon="magnify-alt" size={20} className="text-foreground-subtext" />.
//
// Keep these as React components that accept a `size` prop and render an inline
// SVG with `stroke="currentColor"` (or `fill="currentColor"`) so they inherit
// color through the same CSS paths as the Material Symbols variant.

interface CustomIconRenderProps {
    size: number;
}

export const CUSTOM_ICONS: Record<string, React.FC<CustomIconRenderProps>> = {
    'magnify-alt': ({ size }) => (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="10.5" cy="10.5" r="6.75" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
        </svg>
    ),
};

export function isCustomIcon(name: string): boolean {
    return name in CUSTOM_ICONS;
}
