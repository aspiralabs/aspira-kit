import * as React from 'react';

import { cn } from '../../lib/cn.js';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
    return <div data-slot="skeleton" className={cn('bg-surface animate-pulse', className)} {...props} />;
}

export { Skeleton };
