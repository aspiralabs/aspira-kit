'use client';

import * as RadixAvatar from '@radix-ui/react-avatar';
import * as React from 'react';

import { cn } from '../lib/cn.js';

const AvatarPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixAvatar.Root>,
    React.ComponentPropsWithoutRef<typeof RadixAvatar.Root>
>(({ className, ...props }, ref) => (
    <RadixAvatar.Root
        ref={ref}
        className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-md', className)}
        {...props}
    />
));
AvatarPrimitive.displayName = RadixAvatar.Root.displayName;

const AvatarImagePrimitive = React.forwardRef<
    React.ElementRef<typeof RadixAvatar.Image>,
    React.ComponentPropsWithoutRef<typeof RadixAvatar.Image>
>(({ className, ...props }, ref) => (
    <RadixAvatar.Image ref={ref} className={cn('aspect-square h-full w-full object-cover', className)} {...props} />
));
AvatarImagePrimitive.displayName = RadixAvatar.Image.displayName;

const AvatarFallbackPrimitive = React.forwardRef<
    React.ElementRef<typeof RadixAvatar.Fallback>,
    React.ComponentPropsWithoutRef<typeof RadixAvatar.Fallback>
>(({ className, ...props }, ref) => (
    <RadixAvatar.Fallback
        ref={ref}
        className={cn('flex h-full w-full items-center justify-center rounded-md bg-surface ', className)}
        {...props}
    />
));
AvatarFallbackPrimitive.displayName = RadixAvatar.Fallback.displayName;

export { AvatarPrimitive, AvatarFallbackPrimitive, AvatarImagePrimitive };
