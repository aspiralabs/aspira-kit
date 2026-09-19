'use client';

import { Badge } from '../components/badge/index.js';
import { Button } from '../components/button/index.js';
import { Tooltip } from '../components/tooltip/index.js';
import { Icon } from '../components/icon/index.js';
import { ReactNode, useState } from 'react';

export type MenuItem = {
    label: string;
    paramKey: string;
    badge?: string;
};

export interface PageHeaderConfig {
    title: string;
    tooltip?: string;
    menu?: readonly MenuItem[];
    activeTab?: string;
    onTabChange?: (paramKey: string) => void;
    backHref?: string;
}

/** Right-floated action slot for `Page.Header` (buttons, inputs, text, etc). */
export function PageActions({ children }: { children: ReactNode }) {
    return <>{children}</>;
}
PageActions.displayName = 'Page.Actions';

export function PageHeader({ config, children }: { config: PageHeaderConfig; children?: ReactNode }) {
    const { title, tooltip, menu, activeTab, onTabChange, backHref } = config;
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    const isTabMode = menu && menu.length > 0;

    const handleTabClick = (paramKey: string) => {
        onTabChange?.(paramKey);
        setMobileMenuOpen(false);
    };

    const activeLabel = isTabMode
        ? (menu.find((item) => item.paramKey === activeTab)?.label ?? '')
        : '';

    return (
        <>
            {/* Desktop Header */}
            <div className="hidden sm:flex items-center justify-between gap-4 px-8 h-16 bg-background border-b border-border">
                <div className="flex items-center gap-3 min-w-0">
                    {backHref && (
                        <a href={backHref}>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0">
                                <Icon icon="arrow_left_alt" size={16} />
                            </Button>
                        </a>
                    )}
                    <div className="flex items-center gap-1.5">
                        <h1 className="text-2xl font-semibold text-foreground whitespace-nowrap">
                            {title}
                        </h1>
                        {tooltip && (
                            <Tooltip text={tooltip} side="bottom">
                                <button className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                                    <Icon icon="help" size={14} />
                                </button>
                            </Tooltip>
                        )}
                    </div>

                    {isTabMode && (
                        <>
                            <div className="w-px h-5 bg-border shrink-0" />
                            <div className="flex items-center gap-1">
                                {menu.map((item) => (
                                    <Button
                                        key={item.paramKey}
                                        variant={activeTab === item.paramKey ? 'default' : 'ghost'}
                                        onClick={() => handleTabClick(item.paramKey)}
                                    >
                                        {item.label}
                                        {item.badge && (
                                            <Badge
                                                variant="blue"
                                                className="ml-1.5 font-medium text-[10px] px-1.5 py-0"
                                            >
                                                {item.badge}
                                            </Badge>
                                        )}
                                    </Button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {children && <div className="flex items-center gap-3 shrink-0">{children}</div>}
            </div>

            {/* Mobile Header */}
            <div className="flex sm:hidden items-center justify-between gap-3 px-4 py-3 bg-background border-b border-border">
                <div className="flex items-center gap-2 min-w-0">
                    {backHref && (
                        <a href={backHref}>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0">
                                <Icon icon="arrow_left_alt" size={16} />
                            </Button>
                        </a>
                    )}
                    <div className="flex items-center gap-1.5 min-w-0">
                        <h1 className="text-lg font-semibold text-foreground truncate">{title}</h1>
                        {tooltip && (
                            <Tooltip text={tooltip} side="bottom">
                                <button className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0">
                                    <Icon icon="help" size={14} />
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </div>

                {isTabMode && (
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setMobileMenuOpen((open) => !open)}
                        className="gap-1.5 shrink-0"
                    >
                        {activeLabel || 'Menu'}
                        <Icon
                            icon={mobileMenuOpen ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}
                            size={16}
                        />
                    </Button>
                )}
            </div>

            {/* Mobile expanded menu (tabs + actions) */}
            {isTabMode && mobileMenuOpen && (
                <div className="flex sm:hidden flex-col bg-background border-b border-border">
                    <div className="flex flex-col gap-2 p-4">
                        {menu.map((item) => (
                            <Button
                                key={item.paramKey}
                                variant={activeTab === item.paramKey ? 'default' : 'ghost'}
                                onClick={() => handleTabClick(item.paramKey)}
                                className="justify-start h-12 text-base"
                            >
                                {item.label}
                                {item.badge && (
                                    <Badge
                                        variant="blue"
                                        className="font-medium text-[10px] px-1.5 py-0"
                                    >
                                        {item.badge}
                                    </Badge>
                                )}
                            </Button>
                        ))}
                    </div>
                    {children && (
                        <div className="flex flex-col gap-3 p-4 border-t border-border">
                            {children}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
PageHeader.displayName = 'Page.Header';
