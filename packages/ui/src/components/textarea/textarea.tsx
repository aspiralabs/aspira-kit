'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';
import { FormError } from '../form/index.js';

interface TextareaProps extends React.ComponentProps<'textarea'> {
    label?: string;
    error?: FormError;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, label, error, id, ...props }, ref) => {
        const generatedId = React.useId();
        const inputId = id ?? generatedId;

        return (
            <div className="relative flex flex-col gap-1.5 w-full ">
                {label && (
                    <label htmlFor={inputId} className="text-sm text-foreground font-medium">
                        {label}
                    </label>
                )}
                <textarea
                    ref={ref}
                    id={inputId}
                    data-slot="textarea"
                    aria-invalid={error ? true : undefined}
                    className={cn(
                        'border border-input rounded-md bg-input-bg hover:border-primary focus-visible:border-primary placeholder:text-foreground-subtext aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full px-3 py-2 text-base transition-colors duration-200 outline-none disabled:cursor-not-allowed disabled:opacity-50',
                        {
                            'border-destructive': error,
                            'focus-visible:border-destructive': error,
                        },
                        className,
                    )}
                    {...props}
                />
                {error && (
                    <p className="absolute -bottom-5 left-0 text-sm text-destructive">
                        {error.message}
                    </p>
                )}
            </div>
        );
    },
);

Textarea.displayName = 'Textarea';

export { Textarea };
export type { TextareaProps };
