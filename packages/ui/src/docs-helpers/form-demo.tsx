'use client';

import { useState } from 'react';
import { z } from 'zod';

import { Button } from '../components/button/index.js';
import { Checkbox } from '../components/checkbox/index.js';
import { ChoiceBox } from '../components/choice-box/index.js';
import { Form } from '../components/form/index.js';
import { Input } from '../components/input/index.js';
import { InputDate } from '../components/input-date/index.js';
import { InputOTP } from '../components/input-otp/index.js';
import { InputSelect } from '../components/input-select/index.js';
import { Slider } from '../components/slider/index.js';
import { Switch } from '../components/switch/index.js';
import { Textarea } from '../components/textarea/index.js';
import { ToggleBox } from '../components/toggle-box/index.js';

// =============================================================================
// FORM DEMO
// -----------------------------------------------------------------------------
// Live, end-to-end demo of the `<Form>` wrapper. Lifted verbatim from the
// inline section in `app/(application)/(admin)/admin/design-system/page.tsx`
// so the MDX file (`content/design-system/form.mdx`) can render it via the
// design-system MDX renderer without inlining ~400 lines of stateful TSX.
//
// Why a real component instead of inline MDX? The demo carries:
//   - a Zod schema (12 fields, 3 collection-style validators)
//   - default values + quick-fill values
//   - submit/quick-fill/reset handlers + a 500ms artificial latency
//   - 4-column responsive grid with section dividers
// Keeping this as a TS file means the schema is type-checked end-to-end and
// the MDX stays scannable.
// =============================================================================

const FORM_DEMO_SCHEMA = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Enter a valid email'),
    role: z.string().min(1, 'Role is required'),
    bio: z.string().min(10, 'Bio must be at least 10 characters'),
    birthdate: z.date({ error: () => 'Pick a birthday' }).optional(),
    code: z.string().length(6, 'Enter all 6 digits'),
    tone: z.enum(['professional', 'friendly', 'playful', 'minimalist'], {
        error: () => 'Pick a tone',
    }),
    channels: z.array(z.string()).min(1, 'Pick at least one channel'),
    volume: z.number().min(0).max(100),
    digest: z.boolean(),
    newsletter: z.boolean(),
    acceptTerms: z.boolean().refine((v) => v === true, { message: 'You must accept the terms' }),
});

const FORM_DEMO_ROLE_OPTIONS = [
    { label: 'Owner', value: 'owner' },
    { label: 'Admin', value: 'admin' },
    { label: 'Member', value: 'member' },
    { label: 'Engineer', value: 'engineer' },
    { label: 'Designer', value: 'designer' },
];

const FORM_DEMO_TONE_OPTIONS = [
    { title: 'Professional', description: 'Clear, confident, industry-appropriate.', value: 'professional' },
    { title: 'Friendly', description: 'Warm and approachable.', value: 'friendly' },
] as const;

const FORM_DEMO_CHANNEL_OPTIONS = [
    { title: 'Email', description: 'Daily digest.', value: 'email' },
    { title: 'Slack', description: 'Post to #alerts.', value: 'slack' },
] as const;

type FormDemoValues = z.infer<typeof FORM_DEMO_SCHEMA>;

const FORM_DEMO_EMPTY: FormDemoValues = {
    name: '',
    email: '',
    role: '',
    bio: '',
    birthdate: undefined,
    code: '',
    tone: 'professional',
    channels: [],
    volume: 50,
    digest: false,
    newsletter: false,
    acceptTerms: false,
};

const FORM_DEMO_QUICKFILL: FormDemoValues = {
    name: 'Jane Doe',
    email: 'jane@example.com',
    role: 'engineer',
    bio: 'Frontend engineer who loves clean UI and obsessively aligned titles.',
    birthdate: new Date(1990, 5, 15),
    code: '123456',
    tone: 'friendly',
    channels: ['email', 'slack'],
    volume: 75,
    digest: true,
    newsletter: true,
    acceptTerms: true,
};

export function FormDemo() {
    const [formDefaults, setFormDefaults] = useState<FormDemoValues>(FORM_DEMO_EMPTY);
    const [formPending, setFormPending] = useState<boolean>(false);
    const [formPayload, setFormPayload] = useState<FormDemoValues | null>(null);

    const handleFormSubmit = async (data: FormDemoValues) => {
        setFormPending(true);
        setFormPayload(null);
        await new Promise((resolve) => setTimeout(resolve, 500));
        setFormPayload(data);
        setFormPending(false);
    };

    const handleFormQuickFill = () => {
        setFormPayload(null);
        setFormDefaults(FORM_DEMO_QUICKFILL);
    };

    const handleFormReset = () => {
        setFormPayload(null);
        setFormDefaults({ ...FORM_DEMO_EMPTY });
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-6">
            <div className="border border-border rounded-lg p-6">
                <Form
                    schema={FORM_DEMO_SCHEMA}
                    defaultValues={formDefaults}
                    pending={formPending}
                    onSubmit={handleFormSubmit}
                    className="grid grid-cols-4 gap-x-4 gap-y-5"
                >
                    {/* Identity */}
                    <div className="col-span-2">
                        <Input size="sm" name="name" label="Name" placeholder="Jane Doe" />
                    </div>
                    <div className="col-span-2">
                        <Input
                            size="sm"
                            name="email"
                            label="Email"
                            placeholder="jane@example.com"
                        />
                    </div>
                    <div className="col-span-2">
                        <InputSelect
                            size="sm"
                            name="role"
                            label="Role"
                            placeholder="Pick a role"
                            options={FORM_DEMO_ROLE_OPTIONS}
                        />
                    </div>
                    <div className="col-span-2">
                        <InputDate size="sm" name="birthdate" label="Birthday" />
                    </div>

                    {/* Verification */}
                    <div className="col-span-4 mt-2 pt-5 border-t border-border">
                        <InputOTP name="code" label="Verification code" length={6} />
                    </div>

                    {/* About */}
                    <div className="col-span-4 pt-1">
                        <Textarea
                            name="bio"
                            label="Bio"
                            placeholder="Tell us a little about yourself…"
                            rows={3}
                        />
                    </div>

                    {/* Preferences */}
                    <div className="col-span-4 mt-2 pt-5 border-t border-border space-y-1.5">
                        <p className="text-sm font-medium text-foreground">Tone</p>
                        <ChoiceBox
                            name="tone"
                            options={
                                FORM_DEMO_TONE_OPTIONS as unknown as {
                                    title: string;
                                    description?: string;
                                    value: string;
                                }[]
                            }
                            className="grid-cols-2"
                        />
                    </div>
                    <div className="col-span-4 space-y-1.5">
                        <p className="text-sm font-medium text-foreground">Channels</p>
                        <ChoiceBox
                            name="channels"
                            mode="multi"
                            options={
                                FORM_DEMO_CHANNEL_OPTIONS as unknown as {
                                    title: string;
                                    description?: string;
                                    value: string;
                                }[]
                            }
                            className="grid-cols-2"
                        />
                    </div>
                    <div className="col-span-4 space-y-1.5">
                        <p className="text-sm font-medium text-foreground">Volume</p>
                        <Slider name="volume" min={0} max={100} step={1} />
                    </div>

                    {/* Notifications */}
                    <div className="col-span-4 mt-2 pt-5 border-t border-border">
                        <ToggleBox
                            name="digest"
                            title="Weekly digest"
                            description="Roll-up email every Monday."
                        />
                    </div>
                    <div className="col-span-4 flex items-center justify-end gap-6">
                        <Switch name="newsletter" label="Newsletter" />
                        <Checkbox name="acceptTerms" label="I accept the terms" />
                    </div>

                    {/* Actions */}
                    <div className="col-span-4 mt-2 pt-5 border-t border-border flex justify-end gap-2">
                        <Button variant="secondary" onClick={handleFormQuickFill}>
                            Quick fill
                        </Button>
                        <Button variant="ghost" onClick={handleFormReset}>
                            Reset
                        </Button>
                        <Button type="submit">{formPending ? 'Submitting…' : 'Save'}</Button>
                    </div>
                </Form>
            </div>
            {formPayload && (
                <div className="border border-border rounded-lg p-6 space-y-2 lg:sticky lg:top-6 self-start">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-foreground-subtext">
                        Submitted payload
                    </p>
                    <pre className="bg-surface border border-border p-3 text-xs overflow-x-auto">
                        <code>{JSON.stringify(formPayload, null, 2)}</code>
                    </pre>
                </div>
            )}
        </div>
    );
}
