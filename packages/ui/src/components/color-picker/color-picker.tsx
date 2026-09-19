'use client';

import { cn } from '../../lib/cn.js';
import { useState } from 'react';
import { HexColorInput, HexColorPicker } from 'react-colorful';
import { Icon } from '../icon/index.js';

interface ColorPickerProps {
    value: string;
    onChange: (color: string) => void;
    className?: string;
}

export const ColorPicker = ({ value, onChange, className }: ColorPickerProps) => {
    const [isEyeDropperSupported] = useState(() => typeof window !== 'undefined' && 'EyeDropper' in window);

    const handleEyeDropper = async () => {
        if (!isEyeDropperSupported) return;

        try {
            // @ts-expect-error - EyeDropper API is not fully typed
            const eyeDropper = new window.EyeDropper();
            const result = await eyeDropper.open();
            onChange(result.sRGBHex);
        } catch {
            // User cancelled or error
        }
    };

    return (
        <div className={cn('space-y-3', className)}>
            <HexColorPicker color={value} onChange={onChange} className="w-full! rounded-lg! h-[180px]!" />
            <div className="flex gap-2">
                <div className="flex-1 relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <span className="text-muted-foreground text-sm font-medium">#</span>
                    </div>
                    <HexColorInput
                        color={value}
                        onChange={onChange}
                        className="w-full pl-7 pr-3 py-2.5 text-sm font-medium bg-surface border border-border rounded-lg focus:outline-none focus:bg-background hover:border-primary focus:border-primary transition-colors uppercase"
                        placeholder="000000"
                    />
                </div>
                {isEyeDropperSupported && (
                    <button
                        type="button"
                        onClick={handleEyeDropper}
                        className="size-10 flex items-center justify-center bg-surface hover:bg-surface/80 rounded-lg border border-border text-foreground-subtext hover:text-foreground transition-colors"
                        title="Pick color from screen"
                    >
                        <Icon icon="colorize" size={16} />
                    </button>
                )}
            </div>
            <div className="flex items-center gap-2">
                <div
                    className="size-10 rounded-lg border border-border shadow-sm flex-shrink-0"
                    style={{ backgroundColor: value }}
                />
                <span className="text-sm text-foreground-subtext font-mono">{value.toUpperCase()}</span>
            </div>
        </div>
    );
};

ColorPicker.displayName = 'ColorPicker';

export type { ColorPickerProps };
