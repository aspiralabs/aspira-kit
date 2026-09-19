import { ScrollArea } from '../components/scroll-area/index.js';
import { cn } from '../lib/cn.js';
import { ReactNode } from 'react';

import { PageHeader, PageActions } from './page-header.js';

// NOTE: This module intentionally has NO `'use client'` directive. It is a
// *shared* module so `Page` (and its attached statics `Page.Header` /
// `Page.Content` / `Page.Actions`) resolve correctly when imported by BOTH
// Server and Client Components. If this file were `'use client'`, `Page` would
// become a client-reference proxy in Server Components and `Page.Header` would
// read as `undefined`. The interactive header lives in `./page-header` (which
// IS `'use client'`) and is composed in here as a client reference.

/**
 * `Page` is the app's canonical screen shell: a full-height flex column that
 * hosts a `Page.Header` (top chrome) and one or more `Page.Content` bodies.
 *
 *   <Page>
 *     <Page.Header config={{ title, menu, activeTab, onTabChange }}>
 *       <Page.Actions>{...}</Page.Actions>
 *     </Page.Header>
 *     <Page.Content maxWidth="sm" scroll>{...}</Page.Content>
 *   </Page>
 */
function Page({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('w-full h-full flex flex-col', className)}>{children}</div>;
}

const maxWidthMap = {
    sm: 'max-w-5xl',
    default: 'max-w-[1600px]',
    full: '',
} as const;

interface PageContentProps {
    children: ReactNode;
    maxWidth?: 'sm' | 'default' | 'full';
    scroll?: boolean;
    className?: string;
}

function Content({ children, maxWidth = 'default', scroll = false, className }: PageContentProps) {
    const inner = (
        <div
            className={cn(
                'px-4 py-6 pb-20 sm:px-8 sm:py-10 sm:pb-10',
                maxWidthMap[maxWidth] && `${maxWidthMap[maxWidth]} mx-auto`,
                scroll && 'min-h-full flex flex-col',
                className,
            )}
        >
            {children}
        </div>
    );

    if (scroll) {
        return (
            <div className="flex-1 overflow-hidden">
                <ScrollArea className="h-full">{inner}</ScrollArea>
            </div>
        );
    }

    return <div className="flex-1 min-h-0 overflow-auto">{inner}</div>;
}
Content.displayName = 'Page.Content';

Page.Header = PageHeader;
Page.Actions = PageActions;
Page.Content = Content;

export { Page, Content as PageContent };
export type { MenuItem, PageHeaderConfig } from './page-header.js';
