// Server-side session access, written by `kit add auth`. Map the session to the
// product's own user type here (role, organization) rather than at call sites.
import { headers } from 'next/headers';
import { auth } from '../auth';

export async function getSession() {
    return auth.api.getSession({ headers: await headers() });
}

/** Throws `Unauthorized` when there is no session; route wrappers map it to 401. */
export async function requireSession() {
    const session = await getSession();
    if (!session) throw new Error('Unauthorized');
    return session;
}

/** Re-read the session from the database, e.g. after changing the user's fields. */
export async function refreshSession() {
    return auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
}
