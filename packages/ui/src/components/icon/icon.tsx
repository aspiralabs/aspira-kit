import { cn } from '../../lib/cn.js';
import { CUSTOM_ICONS } from './custom-icons.js';

interface IconProps {
    icon: string;
    size?: number;
    fill?: boolean;
    weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
    grade?: number;
    className?: string;
}

export function Icon({ icon, size = 24, fill = false, weight = 400, grade = 0, className }: IconProps) {
    // Custom registry takes precedence so a project-local SVG can shadow a
    // Material Symbols name if needed. Material Symbols-only props (`fill`,
    // `weight`, `grade`) are intentionally ignored for SVG icons — they're
    // typography variation axes that have no analog in static SVG.
    const Custom = CUSTOM_ICONS[icon];
    if (Custom) {
        return (
            <span
                data-slot="icon"
                className={cn(className)}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: size,
                    height: size,
                    flexShrink: 0,
                    overflow: 'hidden',
                    lineHeight: 1,
                }}
            >
                <Custom size={size} />
            </span>
        );
    }

    return (
        <span
            data-slot="icon"
            className={cn('material-symbols-sharp', className)}
            style={{
                fontSize: size,
                fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' ${weight}, 'GRAD' ${grade}, 'opsz' ${size}`,
                lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: size,
                height: size,
                flexShrink: 0,
                overflow: 'hidden',
            }}
        >
            {icon}
        </span>
    );
}

export type { IconProps };
