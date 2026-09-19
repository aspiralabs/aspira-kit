'use client';

import * as Portal from '@radix-ui/react-portal';
import { NiceModalHandler } from '@ebay/nice-modal-react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { twMerge } from 'tailwind-merge';

import { Button } from '../button/index.js';
import { Icon } from '../icon/index.js';

// ---------------------------------------------------------------------------
// Internal animated dialog primitive (was custom-dialog.tsx)
// ---------------------------------------------------------------------------

interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOutsideClick?: () => void;
    width?: number | string;
    height?: number | string;
    children: React.ReactNode;
}

interface DialogContentProps {
    className?: string;
    children: React.ReactNode;
    width?: number | string;
}

const DialogContext = createContext({});

function Dialog({
    open,
    onOpenChange,
    onOutsideClick,
    children,
    width = '100dvw',
    height = '100dvh',
}: DialogProps) {
    const handleBackdropClick = () => {
        onOutsideClick?.();
        onOpenChange(false);
    };

    return (
        <DialogContext.Provider value={{}}>
            <AnimatePresence>
                {open && (
                    <Portal.Root>
                        <motion.div
                            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 dark:bg-white/10"
                            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                            animate={{ opacity: 1, backdropFilter: 'blur(4px)' }}
                            exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                            transition={{ duration: 0.2 }}
                            style={{ width, height }}
                            onClick={handleBackdropClick}
                        >
                            {children}
                        </motion.div>
                    </Portal.Root>
                )}
            </AnimatePresence>
        </DialogContext.Provider>
    );
}

function DialogContent({ className, children, width = 500 }: DialogContentProps) {
    const context = useContext(DialogContext);
    if (!context) throw new Error('DialogContent must be used within a Dialog');

    return (
        <motion.div
            className={twMerge('z-[100] bg-background relative flex rounded-2xl shadow-xl overflow-hidden', className)}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
            style={{ width }}
        >
            {children}
        </motion.div>
    );
}

// ---------------------------------------------------------------------------
// Modal — the app-facing API
// ---------------------------------------------------------------------------

interface ModalProps {
    children: React.ReactNode;
    className?: string;
    title?: string;
    description?: string;
    icon?: string;
    width?: number | string;
    onOutsideClick?: () => void;
    modal: NiceModalHandler<Record<string, unknown>>;
}

export const Modal = ({
    children,
    className = '',
    title = '',
    description = '',
    icon,
    width = 500,
    onOutsideClick,
    modal,
}: ModalProps) => {
    const [isMounted, setIsMounted] = useState(false);

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            modal.hide();
        }

        setTimeout(() => {
            modal.remove();
        }, 300);
    };

    const handleOutsideClick = () => {
        onOutsideClick?.();
        handleOpenChange(false);
    };

    useEffect(() => {
        if (modal?.visible === false && isMounted) {
            setTimeout(() => {
                modal.remove();
            }, 300);
        }
    }, [modal, isMounted]);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    return (
        <Dialog open={modal.visible} onOpenChange={handleOpenChange} onOutsideClick={handleOutsideClick}>
            <DialogContent className={twMerge('overflow-hidden p-8 ', className)} width={width}>
                <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-4 right-4 z-10 size-8 rounded-full"
                    onClick={() => modal.hide()}
                >
                    <Icon icon="close" size={16} />
                    <span className="sr-only">Close</span>
                </Button>
                <div className="flex-1 flex flex-col min-h-0">
                    {title && (
                        <header className="flex flex-col justify-center items-center mb-4 mt-2">
                            {icon && <Icon icon={icon} size={28} className="text-foreground mb-2" />}
                            <h2 className="font-semibold text-2xl text-center text-foreground">{title}</h2>
                            <p className="text-foreground/80 font-medium text-sm text-center max-w-[400px]">
                                {description}
                            </p>
                        </header>
                    )}
                    <div className="flex flex-1 min-h-0">{children}</div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export type { ModalProps };
