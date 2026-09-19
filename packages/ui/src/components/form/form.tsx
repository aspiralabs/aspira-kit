'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { cn } from '../../lib/cn.js';
import { zodResolver } from '@hookform/resolvers/zod';
import { maskitoNumberOptionsGenerator } from '@maskito/kit';
import React, { ReactElement, useEffect } from 'react';
import { Controller, DefaultValues, Path, Resolver, SubmitHandler, useForm } from 'react-hook-form';
import { TypeOf, z } from 'zod';

interface FormProps<T extends z.ZodType<any, any>> {
    children: React.ReactNode;
    className?: string;
    schema: T;
    onSubmit: (data: z.infer<T>) => void;
    pending?: boolean;
    defaultValues?: DefaultValues<TypeOf<T>>;
    onValueChange?: (data: TypeOf<T>) => void;
    initializing?: boolean;
    skeleton?: React.ReactNode;
}

interface ChildProps {
    name: string;
    [key: string]: any;
}

export const Form = <T extends z.ZodType<any, any>>({
    children,
    className,
    onSubmit,
    schema,
    pending = false,
    defaultValues = undefined,
    onValueChange,
    initializing = false,
    skeleton,
}: FormProps<T>) => {
    type FormData = z.infer<T>;

    // =========================================================================
    // HANDLER
    // =========================================================================
    const onSubmitHandler: SubmitHandler<FormData> = async (data) => {
        onSubmit(data);
    };

    // =========================================================================
    // USE FORM
    // =========================================================================
    const {
        register,
        control,
        handleSubmit,
        watch,
        reset,
        formState: { errors },
    } = useForm<FormData>({
        resolver: zodResolver(schema) as Resolver<FormData>,
        defaultValues,
    });

    useEffect(() => {
        if (defaultValues) {
            reset(defaultValues);
        }
    }, [defaultValues, reset]);

    const watchedValues = watch();

    useEffect(() => {
        if (onValueChange) {
            const parseValues = (values: any): any => {
                const schemaShape = (schema as any).shape;
                const parsedValues = { ...values };
                for (const key in values) {
                    const fieldSchema = schemaShape[key];
                    if (fieldSchema) {
                        const typeName = fieldSchema._def?.typeName;
                        if (typeName === 'ZodNumber') {
                            const value = values[key];
                            parsedValues[key] = value === '' ? null : Number(value);
                        }
                    }
                }
                return parsedValues;
            };
            const parsedValues = parseValues(watchedValues);
            onValueChange(parsedValues);
        }
    }, [watchedValues]);

    // =========================================================================
    // FORM PARSING
    // =========================================================================
    const registerChild = (child: ReactElement<ChildProps>) => {
        const element = child as any; // Remove type checking for now

        if (element.type.displayName === 'Input') {
            const fieldName = child.props.name as Path<FormData>;
            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValues?.[fieldName]}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            onValueChange: ({ typedValue }: { typedValue: any }) =>
                                field.onChange(typedValue ?? undefined),
                            defaultValue: defaultValues?.[fieldName] ?? '',
                            disabled: pending || child.props.disabled,
                            error: errors[fieldName],
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'RadioGroup') {
            const fieldName = child.props.name as Path<FormData>;
            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValues?.[fieldName]}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            onValueChange: field.onChange,
                            value: field.value,
                            disabled: pending || child.props.disabled,
                            error: errors[fieldName],
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'RadioGroupItem') {
            // Just return the RadioGroupItem as is, without wrapping in Controller
            return child;
        }

        // This checks for buttons to disable them on pending
        if (element.type.displayName === 'Button') {
            const buttonProps = {
                ...child.props,
                type: child.props.type || 'button',
                disabled: pending,
                onClick: (e: React.MouseEvent) => {
                    if (child.props.type === 'button') {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    child.props.onClick?.(e);
                },
            };
            return React.cloneElement(child, buttonProps);
        }

        if (element.type.displayName === 'Checkbox') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // includes onChange, onBlur, name, value, ref
                            error,
                            defaultChecked: defaultValues?.[child.props.name as keyof FormData],
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'Switch') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // includes onChange, onBlur, name, value, ref
                            error,
                            defaultChecked: defaultValues?.[child.props.name as keyof FormData],
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'InputSearch') {
            return React.cloneElement(child, {
                ...child.props,
                control,
                register,
                disabled: child.props.disabled || pending,
            });
        }

        if (element.type.displayName === 'ChoiceBox') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            name: fieldName,
                            value: field.value,
                            onChange: field.onChange,
                            onBlur: field.onBlur,
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'InputSelect') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            name: fieldName,
                            value: field.value,
                            onChange: field.onChange,
                            onBlur: field.onBlur,
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'ToggleBox') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // value, onChange, onBlur, name, ref
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'InputDate') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            name: fieldName,
                            value: field.value,
                            onChange: field.onChange,
                            onBlur: field.onBlur,
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'Textarea') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // value, onChange, onBlur, name, ref
                            // Coerce undefined → '' so the textarea stays controlled from
                            // first paint. Without this RHF can deliver `undefined` before
                            // hydration, triggering React's controlled/uncontrolled warning
                            // when the user first types.
                            value: field.value ?? '',
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'InputOTP') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // value, onChange, onBlur, name, ref
                            // Coerce undefined → '' so the OTP stays controlled from first
                            // paint — input-otp errors if value flips between undefined and
                            // a string, which RHF can do before defaultValues hydrate.
                            value: field.value ?? '',
                            error,
                            disabled: pending || child.props.disabled,
                            'aria-invalid': error ? true : undefined,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'Slider') {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const error = errors[fieldName];

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        // Radix Slider speaks number[]. The form field may hold a plain
                        // number (single-thumb) or a number[] (range) depending on the
                        // zod schema — infer from the current value and coerce.
                        const stored = field.value;
                        const isScalar = typeof stored === 'number';
                        const asArray: number[] | undefined = Array.isArray(stored)
                            ? stored
                            : typeof stored === 'number'
                              ? [stored]
                              : undefined;

                        return React.cloneElement(child, {
                            ...child.props,
                            name: fieldName,
                            value: asArray,
                            onValueChange: (next: number[]) => {
                                field.onChange(isScalar ? next[0] : next);
                            },
                            onBlur: field.onBlur,
                            error,
                            disabled: pending || child.props.disabled,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'ColorPicker') {
            const fieldName = child.props.name as any;
            const error = errors[fieldName];
            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValues ? defaultValues[fieldName] : undefined}
                    render={({ field }) => {
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // includes onChange, onBlur, name, value, ref
                            error,
                            disabled: child.props.disabled || pending,
                        });
                    }}
                />
            );
        }

        if (element.type.displayName === 'SimpleSelect') {
            const defaultValue = defaultValues && defaultValues[child.props.name as keyof FormData];

            return React.cloneElement(child, {
                ...child.props,
                register,
                control,
                disabled: child.props.disabled || pending,
                value: child.props.value || defaultValue,
                error: errors[child.props.name as keyof FormData],
            });
        }

        // A Form element like input, select should have a name to br
        // properly supported by the schema
        if (element.props.name) {
            const fieldName = child.props.name as Path<FormData>;
            const defaultValue = defaultValues && defaultValues[fieldName];
            const fieldSchema = (schema as any).shape?.[fieldName];
            const isNumberField = fieldSchema?._def?.typeName === 'ZodNumber';

            let mask: any = undefined;
            if (isNumberField) {
                const min = fieldSchema.minValue;
                const max = fieldSchema.maxValue;

                const maskOptions: any = {
                    decimalSeparator: '.',
                    thousandSeparator: ',',
                };

                if (min) maskOptions.min = min;
                if (max) maskOptions.max = max;

                mask = maskitoNumberOptionsGenerator(maskOptions);
            }

            mask = child.props.mask ? child.props.mask : mask;

            return (
                <Controller
                    name={fieldName}
                    control={control}
                    defaultValue={defaultValue}
                    render={({ field }) => {
                        const error = errors[fieldName];
                        return React.cloneElement(child, {
                            ...child.props,
                            ...field, // includes onChange, onBlur, name, ref, value
                            error,
                            mask,
                            disabled: child.props.disabled || pending,
                            type: isNumberField ? 'number' : child.props.type || 'text',
                        });
                    }}
                />
            );
        }

        return child;
    };

    const registerChildren = (children: React.ReactNode): React.ReactNode => {
        return React.Children.map(children, (child) => {
            const element = child as any; // Remove type checking for now

            if (React.isValidElement(child)) {
                // Detects Button component
                if (element.type.displayName === 'Button') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'Checkbox') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'RadioGroup') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'ChoiceBox') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'InputSelect') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'Slider') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'InputOTP') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'Switch') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'Textarea') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'ToggleBox') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                if (element.type.displayName === 'InputDate') {
                    return registerChild(child as ReactElement<ChildProps>);
                }

                // Detects Form components and divs and stuff
                if (element.props.children) {
                    return React.cloneElement(child, {
                        // @ts-expect-error - need to spread children
                        ...child.props,

                        // @ts-expect-error - need to spread children
                        children: registerChildren(child.props.children),
                    });
                } else {
                    return registerChild(child as ReactElement<ChildProps>);
                }
            } else {
                return child;
            }
        });
    };

    // =========================================================================
    // RENDER
    // =========================================================================

    if (initializing && skeleton) {
        return skeleton;
    }

    return (
        <form onSubmit={handleSubmit(onSubmitHandler)} className={cn('', className)}>
            {registerChildren(children)}
        </form>
    );
};

export type FormError = {
    message: string;
    type: string;
    ref: any;
};
