'use client';

import { Icon } from '../icon/index.js';
import { Tooltip } from '../tooltip/index.js';
import { cn } from '../../lib/cn.js';
import { ReactNode } from 'react';

export interface SegmentedControlItem<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: string;
  tooltip?: string;
  ariaLabel?: string;
  /** Optional pill badge that sits beside the label (e.g. the pricing "20% Off" badge). */
  badge?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  items: SegmentedControlItem<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'default';
  className?: string;
}

const sizeClasses = {
  sm: 'h-9 px-4 text-sm',
  default: 'h-11 px-6 text-sm',
} as const;

// Square-edged design language: a single shared border with a solid card background,
// and a bordered/ringed active segment (rather than a rounded pill with a filled thumb).
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = 'default',
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" className={cn('inline-flex items-center rounded-none bg-card [&>*+*]:-ml-px', className)}>
      {items.map((item) => {
        const active = item.value === value;
        const isIconOnly = item.icon && !item.label;
        const button = (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.ariaLabel}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative inline-flex items-center justify-center gap-2 border border-input font-medium transition-colors cursor-pointer',
              sizeClasses[size],
              isIconOnly && (size === 'sm' ? 'w-9 px-0' : 'w-11 px-0'),
              active
                ? 'z-10 bg-card text-foreground border-primary ring-1 ring-inset ring-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.icon && <Icon icon={item.icon} size={16} />}
            {item.label}
            {item.badge && (
              <span className="whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                {item.badge}
              </span>
            )}
          </button>
        );

        if (isIconOnly && item.tooltip) {
          return (
            <Tooltip key={item.value} text={item.tooltip}>
              {button}
            </Tooltip>
          );
        }
        return button;
      })}
    </div>
  );
}

SegmentedControl.displayName = 'SegmentedControl';

export type { SegmentedControlProps };
