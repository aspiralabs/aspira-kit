/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileInput } from './file-input.js';

const pick = (input: HTMLInputElement, files: File[]) => fireEvent.change(input, { target: { files } });

describe('FileInput', () => {
    it('renders a native file input with the props it is given', () => {
        const { container } = render(<FileInput accept="image/*" multiple name="photos" aria-label="Photos" />);
        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.type).toBe('file');
        expect(input.accept).toBe('image/*');
        expect(input.multiple).toBe(true);
        expect(input.name).toBe('photos');
        expect(input).toHaveAttribute('data-slot', 'file-input');
    });

    it('forwards a ref so a button can open the picker', () => {
        const ref = createRef<HTMLInputElement>();
        render(<FileInput ref={ref} className="hidden" />);
        expect(ref.current?.type).toBe('file');
        const click = vi.spyOn(ref.current as HTMLInputElement, 'click');
        ref.current?.click();
        expect(click).toHaveBeenCalled();
    });

    it('keeps onChange and reports picked files through onFilesChange', () => {
        const onChange = vi.fn();
        const onFilesChange = vi.fn();
        const ref = createRef<HTMLInputElement>();
        render(<FileInput ref={ref} onChange={onChange} onFilesChange={onFilesChange} />);
        const file = new File(['x'], 'cover.png', { type: 'image/png' });
        pick(ref.current as HTMLInputElement, [file]);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onFilesChange).toHaveBeenCalledWith([file]);
    });

    it('accepts spread dropzone-style props, including a ref and inline style', () => {
        const dropzoneRef = vi.fn();
        const onClick = vi.fn();
        const props = { ref: dropzoneRef, style: { display: 'none' }, tabIndex: -1, onClick, autoComplete: 'off' };
        const { container } = render(<FileInput {...props} />);
        const input = container.querySelector('input') as HTMLInputElement;
        expect(dropzoneRef).toHaveBeenCalledWith(input);
        expect(input.style.display).toBe('none');
        expect(input.tabIndex).toBe(-1);
        fireEvent.click(input);
        expect(onClick).toHaveBeenCalled();
    });

    it('lets className override the default styling', () => {
        const { container } = render(<FileInput className="absolute inset-0 opacity-0" />);
        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.className).toContain('opacity-0');
        expect(input.className).toContain('absolute');
    });
});
