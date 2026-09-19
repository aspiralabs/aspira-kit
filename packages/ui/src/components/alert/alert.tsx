import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Icon } from '../icon/index.js';
import { cn } from '../../lib/cn.js';

const alertVariants = cva('relative w-full border-none px-4 py-3 text-sm flex items-start gap-2.5', {
    variants: {
        variant: {
            default:
                'bg-gray-cloud text-foreground [&_[data-slot=alert-description]]:text-foreground-subtext [&_[data-slot=alert-title]]:text-foreground [&_[data-slot=alert-icon]]:text-foreground',
            muted: 'bg-surface text-muted-foreground [&_[data-slot=alert-description]]:text-muted-foreground [&_[data-slot=alert-title]]:text-muted-foreground [&_[data-slot=alert-icon]]:text-muted-foreground',
            blue: 'bg-alert-blue text-alert-blue-foreground [&_[data-slot=alert-description]]:text-alert-blue-foreground [&_[data-slot=alert-title]]:text-alert-blue-foreground [&_[data-slot=alert-icon]]:text-alert-blue-foreground',
            destructive:
                'bg-destructive/10 text-destructive [&_[data-slot=alert-description]]:text-destructive [&_[data-slot=alert-title]]:text-destructive [&_[data-slot=alert-icon]]:text-destructive',
            success:
                'bg-alert-success text-alert-success-foreground [&_[data-slot=alert-description]]:text-alert-success-foreground [&_[data-slot=alert-title]]:text-alert-success-foreground [&_[data-slot=alert-icon]]:text-alert-success-foreground',
        },
    },
    defaultVariants: {
        variant: 'default',
    },
});

const DEFAULT_ICONS: Record<string, string> = {
    default: 'info',
    muted: 'info',
    blue: 'info',
    destructive: 'error',
    success: 'check_circle',
};

function Alert({
    className,
    variant = 'default',
    icon,
    ...props
}: React.ComponentProps<'div'> &
    VariantProps<typeof alertVariants> & {
        icon?: string;
    }) {
    const iconName = icon ?? DEFAULT_ICONS[variant ?? 'default'] ?? 'info';

    return (
        <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
            <div data-slot="alert-icon" className="shrink-0 text-current h-5 flex items-center">
                <Icon icon={iconName} size={20} />
            </div>
            <div className="flex-1 min-w-0">{props.children}</div>
        </div>
    );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-title"
            className={cn('line-clamp-1 text-sm font-medium', className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
    return <div data-slot="alert-description" className={cn('text-sm text-current', className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
