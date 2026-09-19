'use client';

import { cn } from '../../lib/cn.js';
import {
    AvatarFallbackPrimitive,
    AvatarImagePrimitive,
    AvatarPrimitive,
} from '../../primitives/avatar-primitive.js';

interface AvatarProps {
    name?: string | null;
    image?: string | null;
    fallback?: string;
    className?: string;
}

function computeInitials(name?: string | null): string {
    if (!name) return '';
    return name
        .split(' ')
        .map((part) => part.charAt(0))
        .join('')
        .toUpperCase();
}

export function Avatar({ name, image, fallback, className }: AvatarProps) {
    const initials = computeInitials(name);
    const fallbackText = initials || fallback || '';

    return (
        <AvatarPrimitive className={cn('size-10', className)}>
            {image && <AvatarImagePrimitive src={image} />}
            {!image && (
                <AvatarFallbackPrimitive className="bg-primary text-primary-foreground font-semibold">
                    {fallbackText}
                </AvatarFallbackPrimitive>
            )}
        </AvatarPrimitive>
    );
}

export type { AvatarProps };
