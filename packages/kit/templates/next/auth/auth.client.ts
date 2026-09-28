// Browser client for lib/auth.ts, written by `kit add auth`. Keep its plugins in
// step with the server's: each server plugin that adds endpoints needs its client.
import { emailOTPClient, inferAdditionalFields } from 'better-auth/client/plugins';
// #if passkey
import { passkeyClient } from '@better-auth/passkey/client';
// #endif
import { createAuthClient } from 'better-auth/react';
import type { auth } from '../auth';

export const authClient = createAuthClient({
    baseURL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    plugins: [
        inferAdditionalFields<typeof auth>(),
        emailOTPClient(),
        // #if passkey
        passkeyClient(),
        // #endif
    ],
});

export const { signIn, signOut, signUp, useSession } = authClient;
