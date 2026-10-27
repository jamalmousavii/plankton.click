const axios = require('axios');
const { logger } = require('../logger');

// Transactional email via Resend (https://resend.com).
// Requires RESEND_API_KEY. Without it, password reset emails cannot be sent and
// the token is intentionally NOT returned to the API caller.

const RESEND_API_URL = 'https://api.resend.com/emails';

function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function appBaseUrl() {
  return (process.env.BACKEND_URL || 'https://plankton.click').replace(/\/+$/, '');
}

async function sendMail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const from = process.env.EMAIL_FROM || 'Plankton <no-reply@plankton.click>';

  const response = await axios.post(
    RESEND_API_URL,
    { from, to: [to], subject, html, text },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return response.status === 200;
}

async function sendPasswordResetEmail(to, resetToken) {
  const url = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const subject = 'Reset your Plankton password';
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <h2 style="color:#0284c7;margin-top:0">Plankton Network</h2>
      <p>We received a request to reset the password for <strong>${to}</strong>.</p>
      <p style="margin:28px 0">
        <a href="${url}"
           style="background:#0ea5e9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">
          Reset password
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">
        This link expires in 1 hour and can be used once. If you did not request this,
        you can safely ignore this email.
      </p>
      <p style="color:#64748b;font-size:13px">If the button does not work, copy this link:<br>${url}</p>
    </div>`;

  await sendMail({
    to,
    subject,
    html,
    text: `Reset your Plankton password: ${url} (expires in 1 hour)`,
  });

  logger.info({ email: to }, 'Password reset email sent');
}

module.exports = { isEmailConfigured, sendPasswordResetEmail, sendMail };
