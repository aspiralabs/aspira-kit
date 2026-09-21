'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';

import { Icon } from '../icon/index.js';
import { cn } from '../../lib/cn.js';
import { FactoryOpts } from 'imask';
import { useEffect, useRef, useState } from 'react';
import { useIMask } from 'react-imask';
import { FormError } from '../form/index.js';

// Serialize the mask opts into a stable string key. Callers almost always pass
// an inline `mask={{...}}` literal, which is a fresh object every render.
// useIMask keys its options effect on the opts *reference*, so an unstable
// reference makes it call updateOptions() on every render — that fires an
// `accept` event, which setStates the value, which (in a controlled input)
// echoes back through onValueChange → parent setState → re-render → new mask
// object → infinite loop. Keying on the contents keeps the reference stable
// unless the options actually change. Functions (e.g. `mask: Number`) are
// serialized by name since JSON.stringify would otherwise drop them.
function maskKey(mask?: FactoryOpts) {
  if (!mask) return '';
  return JSON.stringify(mask, (_k, v) => (typeof v === 'function' ? v.name || 'fn' : v));
}

const PASSWORD_TOGGLE = {
  default: { button: 'size-10', padding: 'pr-12' },
  sm: { button: 'size-8', padding: 'pr-10' },
  xs: { button: 'size-6', padding: 'pr-8' },
} as const;
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
  // The mask value we last wrote programmatically (from the controlled-value
  // sync below). Used to distinguish user edits from our own sync writes so we
  // don't echo a sync back to the parent and loop. Starts '' to swallow the
  // mask's empty initial emission on mount. One-shot: consumed by the first
  // matching echo, otherwise clearing a field back to '' would never be reported.
  const syncedMaskValue = useRef<string | null>('');
  const [showPassword, setShowPassword] = useState(false);
  // Stable mask reference — see maskKey() above. Without this, an inline mask
  // object passed by the caller re-inits imask every render and loops. The memo
  // is keyed on the serialized contents on purpose, not on `mask` itself.
  const maskOpts = React.useMemo(() => (mask ? mask : { mask: /.*/ }), [maskKey(mask)]);
  const {
    ref,
    value: IValue,
    setValue: setIValue,
    unmaskedValue,
    setUnmaskedValue,
    typedValue,
    maskRef,
  } = useIMask(maskOpts);

  // Propagate changes to the caller — but only genuine user edits. When the
  // controlled-value sync below (or the mask mount) writes a `value` INTO the
  // mask, IValue changes too; echoing that back would drive the parent's state,
  // re-render, and re-sync forever (parent `value` and mask IValue endlessly
  // swap). Skip the echo when IValue matches the value we last wrote ourselves.
  useEffect(() => {
    if (IValue === syncedMaskValue.current) {
      syncedMaskValue.current = null;
      return;
    }
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
    // Record the normalized result so the onValueChange effect above can tell
    // this IValue change came from our sync (not a user edit) and skip the echo.
    syncedMaskValue.current = maskRef.current.value;
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

  // Everything but password renders as text: masks and number-like inputs are handled by imask.
  // A password field carries an eye toggle that swaps it to text while held open.
  const isPassword = type === 'password';
  const inputType = isPassword && !showPassword ? 'password' : 'text';
  const toggleLabel = showPassword ? 'Hide password' : 'Show password';
  const toggleIcon = showPassword ? 'visibility_off' : 'visibility';

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
          type={inputType}
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
            isPassword && PASSWORD_TOGGLE[size].padding,
            className,
          )}
          ref={(el) => {
            ref.current = el;
            inputRef.current = el;
          }}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={toggleLabel}
            tabIndex={-1}
            disabled={props.disabled}
            className={cn(
              PASSWORD_TOGGLE[size].button,
              'absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded-md text-foreground-subtext hover:text-foreground hover:bg-surface transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <Icon icon={toggleIcon} size={20} />
          </button>
        )}

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
