/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { RenderOptions } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ReactElement } from 'react';
import { InputSelect } from './input-select.js';
import { Form } from '../form/index.js';
import { Button } from '../button/index.js';
import { TooltipProviderPrimitive } from '../../primitives/tooltip-primitive.js';

// InputSelect renders an internal <Tooltip>, which requires a TooltipProvider
// in the React tree. The app layout supplies one in production; tests must
// wrap render output explicitly.
const render = (ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) =>
    rtlRender(ui, { wrapper: TooltipProviderPrimitive, ...options });

const stringOptions = [
    { label: 'Option A', value: 'a' },
    { label: 'Option B', value: 'b' },
    { label: 'Option C', value: 'c' },
];

const numberOptions = [
    { label: 'One', value: 1 },
    { label: 'Two', value: 2 },
    { label: 'Three', value: 3 },
];

const booleanOptions = [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
];

describe('InputSelect', () => {
    describe('rendering', () => {
        it('renders with placeholder', () => {
            render(<InputSelect options={stringOptions} placeholder="Pick one" />);
            expect(screen.getByText('Pick one')).toBeInTheDocument();
        });

        it('renders label when provided', () => {
            render(<InputSelect options={stringOptions} label="My Label" />);
            expect(screen.getByText('My Label')).toBeInTheDocument();
        });

        it('does not render label row when no label or error', () => {
            const { container } = render(<InputSelect options={stringOptions} />);
            expect(container.querySelector('[data-slot="select"] > div:first-child > label')).toBeNull();
        });

        it('renders error message', () => {
            const error = { message: 'Required field', type: 'required', ref: null };
            render(<InputSelect options={stringOptions} error={error} />);
            expect(screen.getByText('Required field')).toBeInTheDocument();
        });

        it('renders both label and error together', () => {
            const error = { message: 'Invalid', type: 'validate', ref: null };
            render(<InputSelect options={stringOptions} label="Role" error={error} />);
            expect(screen.getByText('Role')).toBeInTheDocument();
            expect(screen.getByText('Invalid')).toBeInTheDocument();
        });

        it('applies data-slot attribute', () => {
            const { container } = render(<InputSelect options={stringOptions} />);
            expect(container.querySelector('[data-slot="select"]')).toBeInTheDocument();
        });

        it('applies custom className to outer wrapper', () => {
            const { container } = render(<InputSelect options={stringOptions} className="mt-4" />);
            const wrapper = container.querySelector('[data-slot="select"]');
            expect(wrapper?.classList.contains('mt-4')).toBe(true);
        });

        it('shows selected value label', () => {
            render(<InputSelect options={stringOptions} value="b" />);
            expect(screen.getByText('Option B')).toBeInTheDocument();
        });

        it('renders disabled state', () => {
            render(<InputSelect options={stringOptions} disabled />);
            const trigger = screen.getByRole('combobox');
            expect(trigger).toBeDisabled();
        });
    });

    describe('value coercion', () => {
        it('calls onValueChange with string value for string options', async () => {
            const onChange = vi.fn();

            render(<InputSelect options={stringOptions} onValueChange={onChange} placeholder="Pick" />);

            // Open the select
            fireEvent.click(screen.getByRole('combobox'));
            // Click an option
            fireEvent.click(screen.getByText('Option A'));

            expect(onChange).toHaveBeenCalledWith('a');
            expect(typeof onChange.mock.calls[0]![0]).toBe('string');
        });

        it('calls onValueChange with number value for number options', async () => {
            const onChange = vi.fn();

            render(<InputSelect options={numberOptions} onValueChange={onChange} placeholder="Pick" />);

            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByText('Two'));

            expect(onChange).toHaveBeenCalledWith(2);
            expect(typeof onChange.mock.calls[0]![0]).toBe('number');
        });

        it('calls onValueChange with boolean value for boolean options', async () => {
            const onChange = vi.fn();

            render(<InputSelect options={booleanOptions} onValueChange={onChange} placeholder="Pick" />);

            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByText('Yes'));

            expect(onChange).toHaveBeenCalledWith(true);
            expect(typeof onChange.mock.calls[0]![0]).toBe('boolean');
        });

        it('handles false boolean value correctly (not coerced to empty string)', async () => {
            const onChange = vi.fn();

            render(<InputSelect options={booleanOptions} onValueChange={onChange} placeholder="Pick" />);

            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByText('No'));

            expect(onChange).toHaveBeenCalledWith(false);
            expect(onChange.mock.calls[0]![0]).toBe(false);
        });

        it('handles zero number value correctly (not coerced to falsy)', async () => {
            const onChange = vi.fn();
            const opts = [
                { label: 'Zero', value: 0 },
                { label: 'One', value: 1 },
            ];

            render(<InputSelect options={opts} onValueChange={onChange} placeholder="Pick" />);

            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByText('Zero'));

            expect(onChange).toHaveBeenCalledWith(0);
            expect(typeof onChange.mock.calls[0]![0]).toBe('number');
        });

        it('displays selected number value correctly', () => {
            render(<InputSelect options={numberOptions} value={2} />);
            expect(screen.getByText('Two')).toBeInTheDocument();
        });

        it('displays selected boolean value correctly', () => {
            render(<InputSelect options={booleanOptions} value={true} />);
            expect(screen.getByText('Yes')).toBeInTheDocument();
        });
    });

    describe('dev warnings', () => {
        it('warns on duplicate stringified values in development', () => {
            vi.stubEnv('NODE_ENV', 'development');
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const dupeOptions = [
                { label: 'Number 1', value: 1 },
                { label: 'String 1', value: '1' },
            ];

            render(<InputSelect options={dupeOptions} />);

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Duplicate stringified value "1" detected'),
            );

            consoleSpy.mockRestore();
            vi.unstubAllEnvs();
        });
    });

    describe('uncontrolled', () => {
        it('uses defaultValue as initial selection', () => {
            render(<InputSelect options={stringOptions} defaultValue="b" />);
            expect(screen.getByText('Option B')).toBeInTheDocument();
        });

        it('updates internal state after user selection', () => {
            render(<InputSelect options={stringOptions} placeholder="Pick" />);
            const trigger = screen.getByRole('combobox');
            fireEvent.click(trigger);
            fireEvent.click(screen.getByText('Option A'));
            // Selected label should now show in the trigger
            expect(screen.getAllByText('Option A').length).toBeGreaterThan(0);
        });

        it('fires onValueChange as an observer without flipping to controlled mode', () => {
            const onChange = vi.fn();
            render(
                <InputSelect
                    options={stringOptions}
                    defaultValue="a"
                    onValueChange={onChange}
                    placeholder="Pick"
                />,
            );
            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByText('Option B'));
            expect(onChange).toHaveBeenCalledWith('b');
            // Internal state should have advanced — trigger shows the new label
            expect(screen.getAllByText('Option B').length).toBeGreaterThan(0);
        });
    });

    describe('form integration (via <Form>)', () => {
        it('submits the selected value under the name key', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({
                role: z.enum(['owner', 'admin', 'member']),
            });

            render(
                <Form schema={schema} defaultValues={{ role: 'member' }} onSubmit={onSubmit}>
                    <InputSelect
                        name="role"
                        options={[
                            { label: 'Owner', value: 'owner' },
                            { label: 'Admin', value: 'admin' },
                            { label: 'Member', value: 'member' },
                        ]}
                    />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ role: 'member' }));

            fireEvent.click(screen.getByRole('combobox'));
            // Radix renders a hidden <option> alongside the visible listbox item;
            // use the role to pick the visible one.
            fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() =>
                expect(onSubmit).toHaveBeenLastCalledWith({ role: 'admin' }),
            );
        });

        it('preserves number option values through RHF round-trip', async () => {
            const onSubmit = vi.fn();
            const schema = z.object({ count: z.number() });

            render(
                <Form schema={schema} defaultValues={{ count: 1 }} onSubmit={onSubmit}>
                    <InputSelect name="count" options={numberOptions} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByRole('combobox'));
            fireEvent.click(screen.getByRole('option', { name: 'Two' }));
            fireEvent.click(screen.getByText('Submit'));
            // Payload must be the original number 2, not the string "2"
            await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ count: 2 }));
        });

        it('paints destructive border when zod validation fails', async () => {
            const schema = z.object({
                role: z.enum(['owner', 'admin'], { error: () => 'Pick one' }),
            });

            const { container } = render(
                <Form
                    schema={schema}
                    defaultValues={{ role: undefined as unknown as 'owner' }}
                    onSubmit={() => {}}
                >
                    <InputSelect
                        name="role"
                        options={[
                            { label: 'Owner', value: 'owner' },
                            { label: 'Admin', value: 'admin' },
                        ]}
                    />
                    <Button type="submit">Submit</Button>
                </Form>,
            );

            fireEvent.click(screen.getByText('Submit'));
            await waitFor(() => {
                const trigger = container.querySelector('[role="combobox"]') as HTMLElement;
                expect(trigger.className).toContain('border-destructive');
            });
        });

        it('is disabled while Form pending={true}', () => {
            const schema = z.object({ role: z.string() });
            render(
                <Form
                    schema={schema}
                    defaultValues={{ role: 'owner' }}
                    pending
                    onSubmit={() => {}}
                >
                    <InputSelect name="role" options={stringOptions} />
                    <Button type="submit">Submit</Button>
                </Form>,
            );
            expect(screen.getByRole('combobox')).toBeDisabled();
        });
    });
});

describe('InputSelect trigger variants and entryRender', () => {
    it('badge trigger shows the placeholder, then the picked label', () => {
        render(<InputSelect options={stringOptions} triggerVariant="badge" placeholder="Status" />);
        const trigger = screen.getByRole('combobox');
        expect(trigger).toHaveTextContent('Status');
        fireEvent.click(trigger);
        fireEvent.click(screen.getByText('Option B'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Option B');
    });

    it('renders options through entryRender when given', () => {
        const Entry = ({ data }: { data: { label: string } }) => <em data-testid="entry">{data.label.toUpperCase()}</em>;
        render(<InputSelect options={stringOptions} entryRender={Entry} placeholder="Pick" />);
        fireEvent.click(screen.getByRole('combobox'));
        expect(screen.getAllByTestId('entry')).toHaveLength(stringOptions.length);
        expect(screen.getByText('OPTION A')).toBeInTheDocument();
    });
});
