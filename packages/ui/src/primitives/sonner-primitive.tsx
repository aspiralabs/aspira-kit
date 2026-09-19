'use client';

import { Toaster as Sonner, ToasterProps } from 'sonner';

const ToasterPrimitive = (props: ToasterProps) => {
    return (
        <Sonner
            position="bottom-center"
            closeButton
            offset={32}
            toastOptions={{
                style: {
                    borderRadius: 0,
                    width: '400px',
                    fontSize: '16px',
                },
            }}
            {...props}
        />
    );
};

export { ToasterPrimitive };
