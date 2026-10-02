'use client';

import * as React from 'react';

import { cn } from '../../lib/cn.js';

interface FileInputProps extends Omit<React.ComponentProps<'input'>, 'type' | 'value' | 'defaultValue'> {
  /** Called with the picked files as an array, after `onChange`. */
  onFilesChange?: (files: File[]) => void;
}

/**
 * Native file picker. Every input prop and `ref` is forwarded, so it can be
 * hidden and opened from a Button, laid over a drop target, or receive
 * react-dropzone's `getInputProps()`.
 */
function FileInput({ className, onChange, onFilesChange, ...props }: FileInputProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange?.(e);
    onFilesChange?.(Array.from(e.target.files ?? []));
  };

  return (
    <input
      {...props}
      type="file"
      data-slot="file-input"
      onChange={handleChange}
      className={cn(
        'text-sm text-foreground-subtext cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
        'file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-transparent file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:border-primary file:transition-colors',
        className,
      )}
    />
  );
}

FileInput.displayName = 'FileInput';
export { FileInput };
export type { FileInputProps };
