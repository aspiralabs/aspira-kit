'use client';

import * as React from 'react';

import { Icon } from '../icon/index.js';
import {
    DropdownMenuContentPrimitive,
    DropdownMenuItemPrimitive,
    DropdownMenuPrimitive,
    DropdownMenuSubContentPrimitive,
    DropdownMenuSubPrimitive,
    DropdownMenuSubTriggerPrimitive,
    DropdownMenuTriggerPrimitive,
} from '../../primitives/dropdown-menu-primitive.js';

type MenuVariant = 'info' | 'danger';

interface MenuOption {
    key: string;
    label: string;
    icon?: string;
    action?: () => void;
    variant?: MenuVariant;
    disabled?: boolean;
    children?: MenuOption[];
}

interface MenuProps {
    options: MenuOption[];
    children: React.ReactNode;
    align?: 'start' | 'center' | 'end';
    className?: string;
}

function renderOption(option: MenuOption): React.ReactNode {
    if (option.children && option.children.length > 0) {
        return (
            <DropdownMenuSubPrimitive key={option.key}>
                <DropdownMenuSubTriggerPrimitive disabled={option.disabled}>
                    {option.icon && <Icon icon={option.icon} size={16} />}
                    {option.label}
                </DropdownMenuSubTriggerPrimitive>
                <DropdownMenuSubContentPrimitive>
                    {renderItems(option.children)}
                </DropdownMenuSubContentPrimitive>
            </DropdownMenuSubPrimitive>
        );
    }

    return (
        <DropdownMenuItemPrimitive
            key={option.key}
            variant={option.variant === 'danger' ? 'destructive' : 'default'}
            disabled={option.disabled}
            onClick={option.action}
        >
            {option.icon && <Icon icon={option.icon} size={16} />}
            {option.label}
        </DropdownMenuItemPrimitive>
    );
}

function renderItems(options: MenuOption[]): React.ReactNode[] {
    return options.map(renderOption);
}

export function Menu({ options, children, align = 'end', className }: MenuProps) {
    return (
        <DropdownMenuPrimitive>
            <DropdownMenuTriggerPrimitive asChild>{children}</DropdownMenuTriggerPrimitive>
            <DropdownMenuContentPrimitive align={align} className={className}>
                {renderItems(options)}
            </DropdownMenuContentPrimitive>
        </DropdownMenuPrimitive>
    );
}

export type { MenuOption, MenuProps, MenuVariant };
