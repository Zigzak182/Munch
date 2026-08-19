/**
 * Sending the login code.
 *
 * One provider (Resend) and one fallback. The fallback logs the code to the
 * worker's output instead of emailing it, so local development works without
 * an email account — but it never *returns* the code in the response, because
 * an endpoint that hands out login codes is not a fallback, it is an open
 * door.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function body(code, minutes) {
  const text = `Your Munch sign-in code is ${code}.\n\n`
    + `It expires in ${minutes} minutes. If you did not ask for it, ignore this email — `
    + 'nobody can sign in without the code.';

  const html = `<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:16px;line-height:1.5">
  <p>Your Munch sign-in code is:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:.18em;margin:24px 0">${escapeHtml(code)}</p>
  <p style="color:#6f6259">It expires in ${minutes} minutes. If you did not ask for it, ignore
  this email — nobody can sign in without the code.</p>
</div>`;

  return { text, html };
}

/**
 * Send a sign-in code.
 *
 * Returns `{ sent: boolean, via: string }`. A failure to send is reported to
 * the caller rather than thrown, so the route can decide what to tell the
 * user — and it must not tell them whether the address exists.
 */
export async function sendLoginCode({ to, code, minutes, config, fetchImpl = fetch }) {
  if (!config.mail.apiKey || !config.mail.from) {
    // Development. The operator reads the code from `wrangler tail`.
    console.log(`[mail] no provider configured; code for ${to} is ${code}`);
    return { sent: false, via: 'log' };
  }

  const { text, html } = body(code, minutes);

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.mail.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.mail.from,
        to: [to],
        subject: `${code} is your Munch sign-in code`,
        text,
        html,
      }),
    });

    if (!response.ok) {
      console.error('mail send rejected', response.status, (await response.text().catch(() => '')).slice(0, 300));
      return { sent: false, via: 'resend' };
    }

    return { sent: true, via: 'resend' };
  } catch (error) {
    console.error('mail send failed', error);
    return { sent: false, via: 'resend' };
  }
}
