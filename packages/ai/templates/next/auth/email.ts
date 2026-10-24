// Auth emails, written by `kit add auth`. Plain HTML to start; swap in the
// product's React email templates (resend's `react:` option) when it has them.
import { Resend } from 'resend';

// Created on first send: `new Resend()` throws without a key, and at module load
// that would take down the whole auth module (and `next build`) with it.
let resend: Resend | null = null;
const appName = process.env.NEXT_PUBLIC_APP_NAME || 'App';
const from = `${appName} <hello@${process.env.RESEND_DOMAIN}>`;

async function send(to: string, subject: string, html: string) {
    resend ??= new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from, to: [to], subject, html });
    if (error) throw new Error(`[auth] email to ${to} failed: ${error.message}`);
}

export async function sendVerificationOtpEmail({ email, otp, type }: { email: string; otp: string; type: string }) {
    const subject = type === 'forget-password' ? 'Your password reset code' : 'Verify your email address';
    await send(email, subject, `<p>Your ${appName} code is <strong>${otp}</strong>. It expires in one hour.</p>`);
}

export async function sendPasswordResetEmail({ email, url }: { email: string; url: string }) {
    await send(email, 'Reset your password', `<p><a href="${url}">Reset your ${appName} password</a>. If you didn't ask for this, ignore this email.</p>`);
}
