'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';

import { Icon } from '../icon/index.js';
import { cn } from '../../lib/cn.js';
import { FactoryOpts } from 'imask';
import { useEffect, useRef } from 'react';
import { useIMask } from 'react-imask';
import { FormError } from '../form/index.js';
interface InputProps extends Omit<React.ComponentProps<'input'>, 'onBlur' | 'size'> {
  label?: string;
  error?: FormError;
  hint?: string;
  icon?: string;
  onValueChange?: ({ value, typedValue }: { value: string; typedValue: any }) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>, values: { unmaskedValue: string; typedValue: any }) => void;
  mask?: FactoryOpts;
  size?: 'default' | 'sm' | 'xs';
}

const inputSizeClasses = {
  default: 'h-[56px] text-base',
  sm: 'h-10 text-sm',
  xs: 'h-8 text-xs',
} as const;

function Input({
  className,
  type,
  label,
  error,
  hint: _hint,
  icon,
  mask,
  onValueChange,
  onBlur,
  defaultValue,
  value,
  size = 'default',
  ...props
}: InputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSetDefaultValue = useRef<string | number | undefined>(undefined);
  const lastSyncedValue = useRef<React.ComponentProps<'input'>['value']>(undefined);
  const {
    ref,
    value: IValue,
    setValue: setIValue,
    unmaskedValue,
    setUnmaskedValue,
    typedValue,
    maskRef,
  } = useIMask(mask ? mask : { mask: /.*/ });

  // Callback for when a value is changed
  useEffect(() => {
    onValueChange?.({ value: IValue, typedValue });
  }, [IValue]);

  // Set the default value of the input
  useEffect(() => {
    if (!maskRef.current) {
      return;
    }

    // Only update if the defaultValue has actually changed from what we last set
    if (defaultValue === lastSetDefaultValue.current) {
      return;
    }

    if (typeof defaultValue === 'string') {
      maskRef.current.value = defaultValue;
      maskRef.current.updateValue();
      lastSetDefaultValue.current = defaultValue;
    }

    if (typeof defaultValue === 'number') {
      setDefaultValue(String(defaultValue));
      lastSetDefaultValue.current = defaultValue;
    }
  }, [maskRef, defaultValue]);

  // Controlled mode: when a `value` prop is supplied, keep the mask in sync with it.
  // We sync imperatively through iMask rather than passing `value` to the native
  // <input> so that React and iMask don't fight over the DOM value. `onChange`
  // still fires natively (it's spread via ...props), so callers can drive state
  // with `value` + `onChange` exactly like a plain controlled input.
  //
  // `IValue` stays in the dep list so this retries once the mask has mounted
  // (maskRef is null on the first pass when a controlled value is present at
  // mount). But we must only WRITE into the mask when the `value` PROP itself
  // changed — never on an IValue-driven rerun. While the user types, the mask
  // updates `IValue` first and reruns this effect a tick before the parent's
  // onValueChange echo updates `value`; acting then would force the stale prop
  // back into the field, wipe the keystroke, and (via updateValue) re-fire the
  // effect into an infinite render loop. Gating on `valueChanged` keeps typing
  // and external updates (e.g. setting the value from a button) both working.
  useEffect(() => {
    if (value === undefined) {
      return; // uncontrolled — nothing to sync
    }
    if (!maskRef.current) {
      return;
    }
    const next = value === null ? '' : String(value);
    const valueChanged = lastSyncedValue.current !== value;
    lastSyncedValue.current = value;
    if (maskRef.current.value === next) {
      return; // already in sync (e.g. echo of the user's own keystroke)
    }
    if (!valueChanged) {
      return; // IValue-driven rerun with a stale prop — don't clobber typing
    }
    maskRef.current.value = next;
    maskRef.current.updateValue();
  }, [value, maskRef, IValue]);

  // Custom onBlur handler that calls the custom callback with values
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // Call our custom onBlur with values
    onBlur?.(e, { unmaskedValue, typedValue });
  };

  /**
   * This is a hacky way to set the default value of the input with iMask, because the default
   * value does not work properly when using pattern masks.
   *
   * Github issue was opened here:
   * https://github.com/uNmAnNeR/imaskjs/issues/1132
   * @returns
   */
  const setDefaultValue = (value: string) => {
    if (!maskRef.current) {
      return;
    }

    // Simulate highlighting everything and pressing backspace to clear
    // Using IMask API directly to clear the input
    maskRef.current.value = '';
    maskRef.current.updateValue();

    // This will trigger the onValueChange callback with empty values
    setIValue('');
    setUnmaskedValue('');

    setTimeout(() => {
      // Simulate typing "2000" as actual DOM events
      if (!maskRef.current) return;

      // Try to get the actual input element
      const maskElement = maskRef.current.el;
      const inputElement = (maskElement as any)?.input || maskElement;
      const textToType = value;

      if (inputElement && typeof inputElement.dispatchEvent === 'function') {
        // Set the entire value at once
        inputElement.value = textToType;

        // Dispatch a single input event with the complete value
        const inputEvent = new Event('input', {
          bubbles: true,
          cancelable: true,
        });

        inputElement.dispatchEvent(inputEvent);

        // Update IMask after the input event
        if (maskRef.current) {
          maskRef.current.updateValue();
        }
      } else {
        console.log('Could not find valid input element with dispatchEvent method');
      }
    }, 0);
  };

  return (
    <div className="relative flex flex-col  flex-shrink-0 ">
      {(label || error) && (
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-foreground font-medium">{label}</label>
          {error && <p className="text-xs text-destructive font-medium">{error.message}</p>}
        </div>
      )}

      <div className="relative">
        {icon && (
          <Icon
            icon={icon}
            size={20}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground pointer-events-none"
          />
        )}
        <input
          {...props}
          type={type === 'password' ? 'password' : 'text'}
          data-slot="input"
          onBlur={handleBlur}
          className={cn(
            inputSizeClasses[size],
            'border border-input rounded-md focus-visible:border-primary hover:border-primary transition-all duration-200 placeholder:text-foreground-subtext',
            'file:text-foreground  selection:bg-primary selection:text-primary-foreground dark:bg-input-bg flex  w-full min-w-0  border bg-input-bg px-3 py-1   outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
            'aria-invalid:border-destructive',
            '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&[type="number"]]:appearance-textfield',
            { 'border-destructive': error, 'focus-visible:border-destructive': error },
            icon && 'pl-9',
            className,
          )}
          ref={(el) => {
            ref.current = el;
            inputRef.current = el;
          }}
        />

        {/* {hint && (
                    <div className="absolute top-1/2 -translate-y-1/2 right-3 flex items-center gap-1 text-xs text-muted-foreground">
                        <Tooltip text={hint}>
                            <div className="cursor-pointer transition hover:bg-accent rounded-full p-1.5">
                                <CircleAlert className="size-4" />
                            </div>
                        </Tooltip>
                    </div>
                )} */}
      </div>
    </div>
  );
}

Input.displayName = 'Input';
export { Input };
export type { InputProps };
