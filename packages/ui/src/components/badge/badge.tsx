import { cn } from '../../lib/cn.js';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

const badgeVariants = cva(
  'inline-flex  items-center gap-1.5 bg-surface font-medium font-mono rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        pink: 'bg-[var(--badge-pink)] text-[var(--badge-pink-foreground)]',
        purple: 'bg-[var(--badge-purple)] text-[var(--badge-purple-foreground)] border-[var(--badge-purple-border)]',
        blue: 'bg-[var(--badge-blue)] text-[var(--badge-blue-foreground)]',
        indigo: 'bg-[var(--badge-indigo)] text-[var(--badge-indigo-foreground)]',
        orange: 'bg-[var(--badge-orange)] text-[var(--badge-orange-foreground)]',
        gray: 'bg-[var(--badge-gray)] text-[var(--badge-gray-foreground)]',
        green: 'bg-[var(--badge-green)] text-[var(--badge-green-foreground)]',
        // Aliases for legacy/semantic usage
        default: 'bg-[var(--badge-blue)] text-[var(--badge-blue-foreground)]',
        secondary: 'bg-[var(--badge-gray)] text-[var(--badge-gray-foreground)]',
        destructive: 'bg-[var(--badge-pink)] text-[var(--badge-pink-foreground)]',
        warning: 'bg-[var(--badge-orange)] text-[var(--badge-orange-foreground)]',
        brand: 'bg-[var(--badge-purple)] text-[var(--badge-purple-foreground)]',
        accent: 'bg-[var(--badge-indigo)] text-[var(--badge-indigo-foreground)]',
        outline: 'bg-transparent border border-border text-foreground',
      },
      size: {
        sm: 'px-2 py-0.5 text-[10px] ',
        default: 'px-3 py-1 text-xs ',
        lg: 'px-3 py-1 text-sm ',
        xl: 'px-3 h-8 text-sm'
      },
    },
    defaultVariants: {
      variant: 'gray',
      size: 'default',
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({ className, variant, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : 'div';
  return <Comp className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
