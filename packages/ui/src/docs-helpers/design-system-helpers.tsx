'use client';

import { useState } from 'react';

import { Icon } from '../components/icon/index.js';
import { Tooltip } from '../components/tooltip/index.js';
import { cn } from '../lib/cn.js';

export function TokenSwatch({
    label,
    name,
    hex,
    className,
}: {
    label: string;
    name: string;
    hex: string;
    className: string;
}) {
    const [copiedToken, setCopiedToken] = useState(false);
    const [copiedHex, setCopiedHex] = useState(false);

    const copyToken = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(name);
        } catch {
            // Clipboard can be blocked in insecure contexts — silently no-op.
        }
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2000);
    };

    const copyHex = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(hex);
        } catch {
            // see above
        }
        setCopiedHex(true);
        setTimeout(() => setCopiedHex(false), 2000);
    };

    return (
        <div
            className={cn(
                'h-80 rounded-lg flex flex-col justify-between p-6 relative group text-left',
                className,
            )}
        >
            <div className="space-y-1">
                <div className="text-sm opacity-70">{name}</div>
                <div className="text-4xl">{label}</div>
            </div>

            <div className="flex items-end justify-between">
                <div className="space-y-1">
                    <div className="text-sm opacity-70">HEX</div>
                    <div className="text-lg">{hex}</div>
                </div>

                <div className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip text="Copy token name" side="top">
                        <button
                            type="button"
                            onClick={copyToken}
                            className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors"
                        >
                            {copiedToken && <Icon icon="check" size={14} />}
                            {!copiedToken && <Icon icon="content_copy" size={14} />}
                        </button>
                    </Tooltip>
                    <Tooltip text="Copy hex value" side="top">
                        <button
                            type="button"
                            onClick={copyHex}
                            className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors"
                        >
                            {copiedHex && <Icon icon="check" size={16} />}
                            {!copiedHex && <Icon icon="tag" size={16} />}
                        </button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

export function TypeScale({
    size,
    token,
    className,
    children,
}: {
    size: string;
    token: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="grid grid-cols-[120px_1fr] items-center gap-8 py-8">
            <div className="space-y-1">
                <div className="text-base text-foreground-subtext">{size}</div>
                <div className="text-sm text-foreground-subtext/60">{token}</div>
            </div>
            <div className={cn('text-foreground', className)}>{children}</div>
        </div>
    );
}

export function SemanticSwatch({
    label,
    token,
    hex,
    className,
    description,
}: {
    label: string;
    token: string;
    hex: string;
    className: string;
    description: string;
}) {
    return (
        <div
            className={cn(
                'rounded-lg p-5 space-y-2 min-h-[120px] flex flex-col justify-between',
                className,
            )}
        >
            <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs opacity-70">{token}</div>
            </div>
            <div>
                <div className="text-xs opacity-70">{hex}</div>
                <div className="text-xs opacity-60">{description}</div>
            </div>
        </div>
    );
}
