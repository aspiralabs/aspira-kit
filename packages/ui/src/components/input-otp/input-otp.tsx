'use client';

import { OTPInput, OTPInputContext } from 'input-otp';
import * as React from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from '../icon/index.js';
import { FormError } from '../form/index.js';

type InputOTPProps = Omit<
    React.ComponentProps<typeof OTPInput>,
    'maxLength' | 'children' | 'render'
> & {
    containerClassName?: string;
    label?: string;
    error?: FormError;
    /**
     * Number of slots. Auto-renders an InputOTPGroup with sequential slots.
     * Pass `children` instead for advanced compositions (e.g. with separators).
     */
    length?: number;
    /** Override the underlying input-otp maxLength. Defaults to `length`. */
    maxLength?: number;
    children?: React.ReactNode;
};

function InputOTP({
    className,
    containerClassName,
    label,
    error,
    id,
    length,
    maxLength,
    children,
    ...props
}: InputOTPProps) {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const finalMaxLength = maxLength ?? length ?? 6;

    const slotChildren =
        children ??
        (
            <InputOTPGroup>
                {Array.from({ length: finalMaxLength }, (_, i) => (
                    <InputOTPSlot key={i} index={i} />
                ))}
            </InputOTPGroup>
        );

    const invalid = error ? true : undefined;
    const otp = (
        <OTPInput
            data-slot="input-otp"
            id={inputId}
            maxLength={finalMaxLength}
            aria-invalid={invalid}
            containerClassName={cn(
                'flex items-center gap-2 has-disabled:opacity-50',
                error &&
                    '[&_[data-slot=input-otp-slot]]:border-destructive [&_[data-slot=input-otp-slot]]:data-[active=true]:border-destructive',
                containerClassName,
            )}
            className={cn('disabled:cursor-not-allowed', className)}
            {...props}
        >
            {slotChildren}
        </OTPInput>
    );

    if (!label && !error) return otp;

    return (
        <div className="flex flex-col">
            <div className="flex items-center justify-between mb-1.5">
                {label && (
                    <label htmlFor={inputId} className="text-sm text-foreground font-medium">
                        {label}
                    </label>
                )}
                {error && (
                    <p className="text-xs text-destructive font-medium">{error.message}</p>
                )}
            </div>
            {otp}
        </div>
    );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
    return <div data-slot="input-otp-group" className={cn('flex items-center gap-2', className)} {...props} />;
}

function InputOTPSlot({
    index,
    className,
    ...props
}: React.ComponentProps<'div'> & {
    index: number;
}) {
    const inputOTPContext = React.useContext(OTPInputContext);
    const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

    return (
        <div
            data-slot="input-otp-slot"
            data-active={isActive}
            className={cn(
                'border rounded-lg data-[active=true]:border-primary h-[56px] text-base aria-invalid:border-destructive data-[active=true]:aria-invalid:border-destructive dark:bg-input-bg/30 border-input relative flex w-12 items-center justify-center transition-colors outline-none data-[active=true]:z-10',
                className,
            )}
            {...props}
        >
            {char}
            {hasFakeCaret && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="animate-caret-blink bg-foreground h-4 w-px duration-1000" />
                </div>
            )}
        </div>
    );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<'div'>) {
    return (
        <div data-slot="input-otp-separator" role="separator" {...props}>
            <Icon icon="remove" size={16} />
        </div>
    );
}

InputOTP.displayName = 'InputOTP';
InputOTPGroup.displayName = 'InputOTPGroup';
InputOTPSlot.displayName = 'InputOTPSlot';
InputOTPSeparator.displayName = 'InputOTPSeparator';

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot };
