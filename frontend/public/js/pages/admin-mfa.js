import * as shared from '../shared.js';

const { h, request, pageHeader, buttonLink } = shared;

function adminMfaVerifyPage() {
  return `<main class="container admin-mfa-page admin-mfa-verify-page">
    ${pageHeader('Administrator verification', 'Enter an authenticator code or one of your recovery codes to finish signing in.')}
    <section class="card admin-mfa-card admin-mfa-verify-card"><form class="form-grid" data-form="admin-mfa-verify">
      <div class="field"><label for="admin-mfa-login-code">Authenticator or recovery code</label>
        <input class="input" id="admin-mfa-login-code" name="code" type="text" inputmode="text"
          autocomplete="one-time-code" maxlength="40" required></div>
      <button class="button button-primary" type="submit">Verify and sign in</button>
    </form><p class="integration-settings-note">If your sign-in attempt expires, start again from the login page.</p>
    <button class="button button-outline" type="button" data-action="logout">Cancel and sign out</button></section>
  </main>`;
}

async function adminSecurityPage() {
  const status = await request('/admin/mfa');
  return `<main class="container admin-mfa-page">
    ${pageHeader('Security', 'Manage your administrator authenticator and recovery codes.', buttonLink('admin-dashboard', 'Back to dashboard', 'button-secondary'))}
    <section class="card admin-mfa-card">
      <p class="admin-mfa-status">Admin MFA is ${status.enabled ? 'enabled' : 'disabled'} for login.
        ${status.requireForAllAdmins ? 'All administrators must enroll.' : 'Enrollment is optional unless enabled in Integration Settings.'}</p>
      <p class="admin-mfa-status">${status.enrolled ? 'Authenticator enrolled.' : 'No authenticator enrolled.'}
        ${status.pending ? ' A setup is pending; start again to show a fresh QR code.' : ''}</p>
      ${status.enrolled ? `<p class="admin-mfa-status">${status.recoveryCodesRemaining} recovery codes remain.</p>` : ''}
      <section class="admin-mfa-enrollment">
        <h2>${status.enrolled ? 'Replace authenticator' : 'Set up authenticator'}</h2>
        ${status.enrolled ? `<div class="field"><label for="admin-mfa-current-code">Current authenticator or recovery code</label>
          <input class="input" id="admin-mfa-current-code" name="current_code" type="text" autocomplete="one-time-code" maxlength="40"></div>` : ''}
        <button class="button button-primary" type="button" data-action="admin-mfa-enrollment-start"
          data-enrolled="${status.enrolled}">${status.enrolled ? 'Verify and replace authenticator' : 'Set up authenticator'}</button>
        <div class="admin-mfa-qr" data-admin-mfa-qr hidden>
          <p>Scan this QR code with your authenticator app, or enter the secret manually.</p>
          <img data-admin-mfa-qr-image alt="Authenticator setup QR code">
          <p>Manual setup key</p><code data-admin-mfa-secret></code>
          <form class="form-grid" data-form="admin-mfa-enrollment-confirm">
            <div class="field"><label for="admin-mfa-enrollment-code">6-digit authenticator code</label>
              <input class="input" id="admin-mfa-enrollment-code" name="code" type="text" inputmode="numeric"
                autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
            <button class="button button-primary" type="submit">Confirm setup</button>
          </form>
        </div>
      </section>
      ${status.enrolled ? `<section class="admin-mfa-recovery">
        <h2>Recovery codes</h2><p>Each recovery code works once. Store them somewhere private and regenerate them if they may have been exposed.</p>
        <form class="form-grid" data-form="admin-mfa-recovery">
          <div class="field"><label for="admin-mfa-recovery-code">Current 6-digit authenticator code</label>
            <input class="input" id="admin-mfa-recovery-code" name="code" type="text" inputmode="numeric"
              autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
          <button class="button button-outline" type="submit">Generate new recovery codes</button>
        </form></section>` : ''}
      <section class="admin-mfa-recovery-codes" data-admin-mfa-recovery-codes hidden aria-live="polite">
        <h2>Save these recovery codes now</h2><p>They are shown only this once. Regenerating codes invalidates all previous codes.</p>
        <ol data-admin-mfa-recovery-list></ol>
      </section>
      <p class="integration-settings-note">Authenticator codes use 6 digits, a 30-second period, and SHA-1. Keep your device clock set automatically for codes to match.</p>
    </section>
  </main>`;
}

export { adminMfaVerifyPage, adminSecurityPage };
