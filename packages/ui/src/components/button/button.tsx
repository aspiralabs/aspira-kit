import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../../lib/cn.js'

// Migrated from SAAS_BOILER components/ui/core/button on 2026-09-19.
// One change: `rounded-none` became `rounded-md` so the radius tokens reach
// buttons. With --radius-on: 0 (the SAAS_BOILER default) that still renders square.
const buttonVariants = cva(
  "inline-flex !cursor-pointer items-center justify-center gap-2 whitespace-nowrap text-base font-[500] transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive rounded-md",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline: 'border border-border text-foreground hover:border-primary',
        secondary: 'bg-surface text-foreground hover:bg-surface/70 dark:bg-surface dark:hover:bg-surface/70',
        ghost: 'text-foreground hover:bg-surface',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2 has-[>svg]:px-4 has-[>[data-slot=icon]]:pl-3.5 has-[>[data-slot=icon]]:pr-5 text-sm',
        sm: 'h-10 gap-1.5 px-4 has-[>svg]:px-3 has-[>[data-slot=icon]]:pl-2.5 has-[>[data-slot=icon]]:pr-4 text-sm',
        lg: 'h-14 px-8 has-[>svg]:px-6 has-[>[data-slot=icon]]:pl-5 has-[>[data-slot=icon]]:pr-8 text-base',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

Button.displayName = 'Button'

export { Button, buttonVariants }
