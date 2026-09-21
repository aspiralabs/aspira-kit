'use client';

import { cn } from '../../lib/cn.js';
import * as React from 'react';

interface EditableTextProps {
    value: string;
    onSave?: (value: string) => void;
    className?: string;
}

export function EditableText({ value, onSave, className }: EditableTextProps) {
    const [isEditing, setIsEditing] = React.useState(false);
    const [editValue, setEditValue] = React.useState('');
    const inputRef = React.useRef<HTMLInputElement>(null);
    const cancelledRef = React.useRef(false);

    const startEditing = () => {
        setEditValue(value);
        setIsEditing(true);
        cancelledRef.current = false;
    };

    const commitEdit = () => {
        if (cancelledRef.current) return;
        const trimmed = editValue.trim();
        setIsEditing(false);
        if (trimmed && trimmed !== value) {
            onSave?.(trimmed);
        }
    };

    const cancelEdit = () => {
        cancelledRef.current = true;
        setIsEditing(false);
    };

    React.useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    // Sizer text: while editing, mirror the draft (an nbsp keeps the box from collapsing).
    const sizerText = isEditing ? editValue || ' ' : value;

    return (
        <div className={cn(className, 'relative min-w-0')}>
            {/* Sizer span — always rendered, invisible during editing to size the container */}
            <span
                className={cn('block', isEditing ? 'invisible whitespace-pre' : 'truncate cursor-default')}
                onDoubleClick={(e) => {
                    if (!isEditing) {
                        e.stopPropagation();
                        startEditing();
                    }
                }}
            >
                {sizerText}
            </span>
            {isEditing && (
                <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            commitEdit();
                        } else if (e.key === 'Escape') {
                            cancelEdit();
                        }
                        e.stopPropagation();
                    }}
                    onBlur={commitEdit}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute inset-0 w-full bg-transparent outline-none border-b border-brand-blue"
                    style={{ font: 'inherit', color: 'inherit', letterSpacing: 'inherit' }}
                />
            )}
        </div>
    );
}

export type { EditableTextProps };
