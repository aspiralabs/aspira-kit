/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Slider } from './slider.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';

// Radix Slider thumbs respond to arrow keys — simulate user input with keyboard
// since JSDOM/happy-dom don't support pointer capture.
const press = (el: HTMLElement, key: string) => fireEvent.keyDown(el, { key });

describe('Slider', () => {
    describe('scalar coercion (defensive)', () => {
        // Regression: `quick fill` on the Form demo passed a scalar through to Radix
        // when the wrapper wasn't coercing, causing `context.values.map is not a function`
        // inside SliderPrimitive.Range. The wrapper must accept a bare number.
        it('accepts a scalar `value` prop without crashing', () => {
            const spy = vi.fn();
            expect(() => {
                // @ts-expect-error — the public types say number[], but the wrapper has a
                // runtime coercion for safety; this test verifies it.
                render(<Slider value={42} min={0} max={100} onValueChange={spy} />);
            }).not.toThrow();
            expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '42');
        });

        it('accepts a scalar `defaultValue` prop without crashing', () => {
            expect(() => {
                // @ts-expect-error — see above.
                render(<Slider defaultValue={30} min={0} max={100} />);
            }).not.toThrow();
            expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '30');
        });
    });

    describe('uncontrolled', () => {
        it('renders one thumb for a single-value defaultValue', () => {
            render(<Slider defaultValue={[40]} min={0} max={100} />);
            expect(screen.getAllByRole('slider')).toHaveLength(1);
        });

        it('renders two thumbs for a range defaultValue', () => {
            render(<Slider defaultValue={[20, 80]} min={0} max={100} />);
            expect(screen.getAllByRole('slider')).toHaveLength(2);
        });

        it('updates internal state on keyboard input', () => {
            render(<Slider defaultValue={[50]} min={0} max={100} step={1} />);
            const thumb = screen.getByRole('slider');
            expect(thumb).toHaveAttribute('aria-valuenow', '50');
            press(thumb, 'ArrowRight');
            expect(thumb).toHaveAttribute('aria-valuenow', '51');
            press(thumb, 'ArrowLeft');
            press(thumb, 'ArrowLeft');
            expect(thumb).toHaveAttribute('aria-valuenow', '49');
        });
    });

    describe('controlled', () => {
        it('reflects the value prop', () => {
            const { rerender } = render(
                <Slider value={[30]} min={0} max={100} onValueChange={() => {}} />,
            );
            expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '30');

            rerender(<Slider value={[70]} min={0} max={100} onValueChange={() => {}} />);
            expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '70');
        });

        it('does not self-update — parent drives state', () => {
            render(<Slider value={[50]} min={0} max={100} step={1} onValueChange={() => {}} />);
            const thumb = screen.getByRole('slider');
            press(thumb, 'ArrowRight');
            // Parent ignored the change, so the DOM must still show 50
            expect(thumb).toHaveAttribute('aria-valuenow', '50');
        });

        it('fires onValueChange with a number[]', () => {
            const onChange = vi.fn();
            render(
                <Slider value={[50]} min={0} max={100} step={1} onValueChange={onChange} />,
            );
            press(screen.getByRole('slider'), 'ArrowRight');
            expect(onChange).toHaveBeenCalledWith([51]);
        });
    });

    describe('error', () => {
        it('paints destructive on range + thumb when error is truthy', () => {
            const { container } = render(<Slider defaultValue={[50]} error={{ message: 'bad' }} />);
            const range = container.querySelector('[data-slot="slider-range"]') as HTMLElement;
            const thumb = container.querySelector('[data-slot="slider-thumb"]') as HTMLElement;
            expect(range.className).toContain('bg-destructive');
            expect(thumb.className).toContain('border-destructive');
        });

        it('exposes data-error on the root when error is truthy', () => {
            const { container } = render(<Slider defaultValue={[50]} error={{ message: 'bad' }} />);
            const root = container.querySelector('[data-slot="slider"]') as HTMLElement;
            expect(root).toHaveAttribute('data-error', '');
        });

        it('does not paint destructive when there is no error', () => {
            const { container } = render(<Slider defaultValue={[50]} />);
            const range = container.querySelector('[data-slot="slider-range"]') as HTMLElement;
            expect(range.className).toContain('bg-primary');
            expect(range.className).not.toContain('bg-destructive');
        });
    });

    describe('form integration (via <Form>) — scalar field', () => {
        it('submits a plain number when the schema is z.number()', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ volume: z.number().min(0).max(100) });

            render(
                <Form schema={schema} defaultValues={{ volume: 50 }} onSubmit={onSubmit}>
                    <Slider name="volume" min={0} max={100} step={1} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ volume: 50 }));

            press(screen.getByRole('slider'), 'ArrowRight');
            press(screen.getByRole('slider'), 'ArrowRight');
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ volume: 52 }));
        });

        it('renders a single thumb when the RHF field is a plain number', () => {
            const schema = z.object({ volume: z.number() });
            render(
                <Form schema={schema} defaultValues={{ volume: 30 }} onSubmit={() => {}}>
                    <Slider name="volume" min={0} max={100} />
                </Form>,
            );
            expect(screen.getAllByRole('slider')).toHaveLength(1);
        });
    });

    describe('form integration (via <Form>) — range field', () => {
        it('submits a number[] when the schema is z.array(z.number())', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({
                range: z.tuple([z.number(), z.number()]),
            });

            render(
                <Form schema={schema} defaultValues={{ range: [20, 80] }} onSubmit={onSubmit}>
                    <Slider name="range" min={0} max={100} step={1} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ range: [20, 80] }));

            const [lowThumb] = screen.getAllByRole('slider');
            press(lowThumb!, 'ArrowRight');
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ range: [21, 80] }));
        });

        it('renders two thumbs when the RHF field is a number[]', () => {
            const schema = z.object({ range: z.tuple([z.number(), z.number()]) });
            render(
                <Form schema={schema} defaultValues={{ range: [10, 90] }} onSubmit={() => {}}>
                    <Slider name="range" min={0} max={100} />
                </Form>,
            );
            expect(screen.getAllByRole('slider')).toHaveLength(2);
        });
    });

    describe('form integration (via <Form>) — misc', () => {
        it('paints destructive on the track when zod validation fails', async () => {
            const schema = z.object({
                volume: z.number().min(80, { message: 'Too quiet' }),
            });

            const { container } = render(
                <Form schema={schema} defaultValues={{ volume: 10 }} onSubmit={() => {}}>
                    <Slider name="volume" min={0} max={100} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const range = container.querySelector('[data-slot="slider-range"]') as HTMLElement;
                expect(range.className).toContain('bg-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ volume: z.number() });
            render(
                <Form
                    schema={schema}
                    defaultValues={{ volume: 50 }}
                    pending
                    onSubmit={() => {}}
                >
                    <Slider name="volume" min={0} max={100} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            // Radix marks the root with data-disabled when any thumb is disabled
            const root = screen.getByRole('slider').closest('[data-slot="slider"]');
            expect(root).toHaveAttribute('data-disabled');
        });
    });
});
