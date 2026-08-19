/**
 * The sign-in strip.
 *
 * Deliberately small and at the bottom of the page. Munch is two questions
 * and a map; an account is only how a subscription travels between a phone
 * and a laptop, so it must never stand between someone and their dinner.
 * Nothing here gates anything — the whole section is hidden when no backend
 * is configured.
 *
 * Two steps in one form: an address, then the code that arrives. The second
 * field appears in place rather than on a new screen, so the flow never
 * leaves the results behind.
 */

import { hasApi } from './config.js';
import * as api from './providers/api.js';

const $ = (id) => document.getElementById(id);

/** Which half of the form we are on. */
let awaitingCode = false;
let pendingEmail = '';

function setStatus(message, tone = '') {
  const status = $('account-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

/** Render the signed-in / signed-out state. */
async function refresh() {
  const state = $('account-state');
  const form = $('account-form');

  let entitlement;
  try {
    entitlement = await api.entitlement();
  } catch {
    // The backend is unreachable. Say nothing rather than showing a broken
    // sign-in box — the app itself will report the failure where it matters.
    $('account').hidden = true;
    return;
  }

  if (entitlement.signedIn) {
    const plan = entitlement.tier === 'plus' ? 'Munch+' : 'free';
    state.innerHTML = `Signed in as <strong>${escapeHtml(entitlement.email)}</strong> · ${plan}`;
    form.hidden = true;
    ensureSignOut();
  } else {
    state.textContent = 'Signed in on one device? Sign in to carry Munch+ across to another.';
    form.hidden = false;
    removeSignOut();
  }
}

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function ensureSignOut() {
  if ($('account-signout')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'account-signout';
  button.className = 'link-btn';
  button.textContent = 'Sign out';
  button.addEventListener('click', () => {
    api.signOut();
    awaitingCode = false;
    pendingEmail = '';
    resetForm();
    setStatus('Signed out.', 'ok');
    refresh();
  });

  $('account-state').append(' ', button);
  ensureDelete();
}

/**
 * Account deletion, in the app.
 *
 * Not a nicety: Play requires a route to deletion and App Store guideline
 * 5.1.1(v) requires it in-app, so an app with accounts and no delete button
 * fails review.
 */
function ensureDelete() {
  if ($('account-delete')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'account-delete';
  button.className = 'link-btn link-btn--quiet';
  button.textContent = 'Delete account';
  button.addEventListener('click', async () => {
    const sure = globalThis.confirm(
      'Delete your Munch account and its records?\n\n'
      + 'This cannot be undone. It does not cancel a subscription — do that in '
      + 'Google Play or the App Store.',
    );
    if (!sure) return;

    try {
      setStatus('Deleting…', 'busy');
      const result = await api.deleteAccount();
      awaitingCode = false;
      pendingEmail = '';
      resetForm();
      setStatus(result?.note ?? 'Account deleted.', 'ok');
      await refresh();
      document.dispatchEvent(new CustomEvent('munch:entitlement-changed'));
    } catch (error) {
      setStatus(error?.message ?? 'Could not delete the account.', 'error');
    }
  });

  $('account-state').append(' · ', button);
}

function removeSignOut() {
  $('account-signout')?.remove();
  $('account-delete')?.remove();
}

function resetForm() {
  const code = $('account-code');
  code.hidden = true;
  code.value = '';
  $('account-email').hidden = false;
  $('account-submit').textContent = 'Sign in';
}

/** Step one: ask for a code. */
async function requestCode(email) {
  setStatus('Sending a code…', 'busy');
  await api.requestLoginCode(email);

  pendingEmail = email;
  awaitingCode = true;

  $('account-email').hidden = true;
  const code = $('account-code');
  code.hidden = false;
  code.focus();
  $('account-submit').textContent = 'Confirm';

  // Deliberately does not say whether the address has an account — the
  // server does not tell us, and neither should this.
  setStatus(`If ${email} can receive mail, a 6-digit code is on its way.`, 'ok');
}

/** Step two: exchange it. */
async function submitCode(code) {
  setStatus('Checking…', 'busy');
  const result = await api.verifyLoginCode(pendingEmail, code);

  awaitingCode = false;
  pendingEmail = '';
  resetForm();

  setStatus(result.tier === 'plus'
    ? 'Signed in. Munch+ is active on this device.'
    : 'Signed in.', 'ok');

  await refresh();
  document.dispatchEvent(new CustomEvent('munch:entitlement-changed'));
}

async function onSubmit(event) {
  event.preventDefault();
  const submit = $('account-submit');
  submit.disabled = true;

  try {
    if (awaitingCode) {
      await submitCode($('account-code').value.trim());
    } else {
      const email = $('account-email').value.trim();
      if (!email) {
        setStatus('Enter your email address first.', 'warn');
        return;
      }
      await requestCode(email);
    }
  } catch (error) {
    setStatus(error?.message ?? 'That did not work. Try again.', 'error');
  } finally {
    submit.disabled = false;
  }
}

/** Wire up the strip, or leave it hidden when there is no backend. */
export function initAccount() {
  const section = $('account');
  if (!section) return;

  if (!hasApi()) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  $('account-form').addEventListener('submit', onSubmit);
  refresh();
}
