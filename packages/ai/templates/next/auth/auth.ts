// Better Auth, written by `kit add auth`. This file is the product's now: edit it freely.
//
// Rules that hold whatever you change:
//   - Server-owned user fields (role, organizationId, plan, suspended...) must be
//     `input: false`. Without it any signed-in user can set them through sign-up
//     or POST /api/auth/update-user.
//   - `nextCookies()` stays the last plugin, or server actions can't set cookies.
//   - Rate limits live in Redis so they hold across instances.
//
// Env: BETTER_AUTH_URL, BETTER_AUTH_SECRET, NEXT_PUBLIC_APP_URL, REDIS_URL,
// RESEND_API_KEY, RESEND_DOMAIN, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET (optional),
// PASSKEY_RP_ID, PASSKEY_ORIGIN (optional overrides).
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { emailOTP } from 'better-auth/plugins';
// #if passkey
import { passkey } from '@better-auth/passkey';
// #endif
// #if expo
import { expo } from '@better-auth/expo';
// #endif
import { sendPasswordResetEmail, sendVerificationOtpEmail } from './auth/email';
import { prisma } from './prisma';
import { getRedis } from './redis';

const appUrl = (process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(
    /\/$/,
    '',
);
const appName = process.env.NEXT_PUBLIC_APP_NAME || 'App';
// #if passkey

// WebAuthn relying party: `rpID` is the host only, `origin` the exact browser
// origin. A malformed URL falls back to localhost instead of throwing at module
// load, which would take the whole auth module down with it.
function hostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'localhost';
    }
}
const passkeyRpID = process.env.PASSKEY_RP_ID || hostname(appUrl);
const passkeyOrigin = (process.env.PASSKEY_ORIGIN || appUrl).replace(/\/$/, '');
// #endif

const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const auth = betterAuth({
    appName,
    baseURL: appUrl,
    secret: process.env.BETTER_AUTH_SECRET,
    // Wrap the adapter here to run product setup when a user is created
    // (organization, billing customer). Strip any non-column fields before insert.
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    secondaryStorage: {
        get: async (key) => (await getRedis().get(key)) ?? null,
        set: async (key, value, ttl) => {
            if (ttl) await getRedis().set(key, value, 'EX', ttl);
            else await getRedis().set(key, value);
        },
        delete: async (key) => {
            await getRedis().del(key);
        },
    },
    rateLimit: {
        enabled: true,
        storage: 'secondary-storage',
        window: 60,
        max: 100,
        customRules: {
            '/sign-in/email': { window: 60, max: 10 },
            '/sign-up/email': { window: 60, max: 10 },
            '/email-otp/send-verification-otp': { window: 60, max: 5 },
            '/request-password-reset': { window: 60, max: 5 },
            '/reset-password': { window: 60, max: 5 },
        },
    },

    user: {
        // Product fields surfaced on the session. Server-owned ones need
        // `input: false`; only fields a user may set at sign-up leave it out.
        additionalFields: {
            suspended: { type: 'boolean', defaultValue: false, input: false },
            lastLoginAt: { type: 'date', required: false, input: false },
            // role: { type: 'string', defaultValue: 'USER', input: false },
            // organizationId: { type: 'string', required: false, input: false },
        },
    },

    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
            await sendPasswordResetEmail({ email: user.email, url });
        },
    },
    emailVerification: { autoSignInAfterVerification: true },

    socialProviders: googleConfigured
        ? {
              google: {
                  clientId: process.env.AUTH_GOOGLE_ID as string,
                  clientSecret: process.env.AUTH_GOOGLE_SECRET as string,
              },
          }
        : {},

    advanced: {
        cookiePrefix: 'auth',
        useSecureCookies: process.env.NODE_ENV === 'production',
    },

    trustedOrigins: [
        appUrl,
        process.env.NEXT_PUBLIC_APP_URL,
        // #if expo
        '{{scheme}}://',
        // Expo Go uses exp:// with the device's local IP.
        ...(process.env.NODE_ENV === 'development' ? ['exp://', 'exp://**', 'exp://192.168.*.*:*/**'] : []),
        // #endif
    ].filter(Boolean) as string[],

    databaseHooks: {
        session: {
            create: {
                // Suspended users can't start a session.
                before: async (session) => {
                    const user = await prisma.user.findUnique({
                        where: { id: session.userId },
                        select: { suspended: true },
                    });
                    if (user?.suspended) return false;
                    return { data: session };
                },
                // Best-effort: never block sign-in on the timestamp.
                after: async (session) => {
                    try {
                        await prisma.user.update({
                            where: { id: session.userId },
                            data: { lastLoginAt: new Date() },
                        });
                    } catch (error) {
                        console.warn('[auth] failed to stamp lastLoginAt', error);
                    }
                },
            },
        },
    },

    plugins: [
        emailOTP({
            sendVerificationOnSignUp: true,
            overrideDefaultEmailVerification: true,
            otpLength: 6,
            expiresIn: 3600,
            allowedAttempts: 5,
            storeOTP: 'hashed',
            sendVerificationOTP: async ({ email, otp, type }) => {
                await sendVerificationOtpEmail({ email, otp, type });
            },
        }),
        // #if passkey
        passkey({
            rpID: passkeyRpID,
            rpName: appName,
            origin: passkeyOrigin,
            // Platform authenticators preferred, security keys allowed. Resident
            // keys enable usernameless and autofill sign-in.
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
            },
        }),
        // #endif
        // #if expo
        expo(),
        // #endif
        // Must be last.
        nextCookies(),
    ],
});

export type Session = typeof auth.$Infer.Session;
