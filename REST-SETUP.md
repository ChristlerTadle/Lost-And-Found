# Separate Frontend and REST API

The current app uses a static HTML/CSS/JavaScript frontend and a JSON API on separate ports. Older application files have been moved under `archived\` and are not part of this setup.

## Folder layout

- `frontend\server.js` serves the frontend on its own port.
- `frontend\public\app.js` starts the browser app and connects the page modules.
- `frontend\public\js\pages\` contains the public, user, staff, and admin page renderers.
- `frontend\public\js\shared.js` contains shared frontend state, API calls, and UI helpers.
- `backend\server.js` starts the JSON API.
- `backend\routes\api.js` declares API endpoints and applies authentication and role middleware.
- `backend\controllers\` contains request handlers grouped by feature.
- `backend\middlewares\` contains shared request-processing middleware.
- `backend\config\role-permissions.js` defines the User and Staff permission catalog, dependencies, and route map.
- `src\services\role-permissions.js` reads and updates role-wide permissions in MongoDB.
- `src\services\audit-log.js` is the central append-only audit writer and provides paginated System Records queries.
- Older SQL schemas, the PHP app, the EJS app, MySQL import utility, and a ZIP backup are kept under `archived\`.
- `assets\app.css` and `src\` stay in the project root because the current frontend and API still use them.

## Run locally

Start MongoDB, then open two PowerShell windows at the project root.

In the first window, start the API:

```powershell
npm.cmd start
```

In the second window, start the frontend:

```powershell
npm.cmd run start:frontend
```

Open `http://localhost:5173`. The frontend uses `http://localhost:3001/api` by default. The API reads the existing root `.env` configuration and uses the existing MongoDB collections and business services.

The API and frontend need the project dependencies installed at the root. If they are not installed yet, run `npm.cmd install` from the project root.

Before deploying role-based permissions, run:

```powershell
npm.cmd run migrate:role-permissions
```

It prints a read-only summary of differences in existing per-staff assignments, then seeds the `role_permissions` collection with all User and Staff permissions enabled. Existing settings are preserved on reruns, so changes made later in **Role Permissions** are not reset. Admin access is fixed and is not editable. The old `staff_permissions` collection is not changed or removed; retain it until its removal is explicitly approved. The migration does not create an admin account or set credentials.

Before deploying the general audit log, run:

```powershell
npm.cmd run migrate:general-audit-log
```

This migration copies `permission_audit_log` and `access_denied_log` into `audit_log`, preserves timestamps, verifies each source count, and only then drops the old collections. It is safe to rerun; review the reported counts and keep a database backup before the first production run.

### Integration settings and secret encryption

The Admin **Settings** page stores Google OAuth, reCAPTCHA, SMTP, and Google Calendar settings in the existing MongoDB `integration_settings` collection. Integration secrets are encrypted with AES-256-GCM. Before starting the updated API, create a stable encryption key and put it in the root `.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the output as `INTEGRATION_ENCRYPTION_KEY`. Keep a secure backup of this key; do not put it in MongoDB or source control. The API fails at startup if the key is missing or malformed, and reports a clear startup error if it cannot decrypt stored secrets. Losing the key makes existing encrypted settings unrecoverable; restore the key backup or re-enter the integration credentials.

With the key set and the previous integration environment variables still present, run the idempotent migration before starting the API:

```powershell
npm.cmd run migrate:integrations
```

It copies non-empty environment settings into MongoDB, encrypts secret fields, preserves existing Google/reCAPTCHA enabled states, and sets SMTP enabled only when the SMTP environment configuration is complete. It logs integration IDs and field names, never values. The Admin page then supports pending edits, Save Changes, Cancel, field-level validation, and masked secrets. SMTP **Test Connection** verifies the current form values without sending an email. Google sign-in and reCAPTCHA **Test Connection** actions check the saved OAuth credentials and reCAPTCHA server secret with Google, without signing in a user or requiring a CAPTCHA challenge. A successful test saves the current saved configuration as that integration's default; it does not test unsaved form edits.

Google Calendar uses the pinned official Calendar-only Node.js client, `@googleapis/calendar@16.0.0`, and a service account (not per-user OAuth). Enable Calendar API for the service-account project, create or select one organization pickup calendar, and share **only that dedicated calendar** with the service-account email with permission to manage events. Do not grant the service account organization-wide calendar access or domain-wide delegation. In Admin → Settings, enter the calendar ID, service-account email, and private key; changes to these credentials require the Integration Settings PIN and emailed verification code. The key is encrypted at rest and fully masked in settings. Test Connection checks the saved credentials and calendar access without changing calendar data; a successful test saves the current configuration as the default. Pickup settings default to Asia/Manila, Buksu SSC Office, 08:00–17:00 Monday–Saturday, and can be changed on that card. After deploying, rerun `npm.cmd run migrate:role-permissions` to seed **Schedule pickup** as enabled for the Staff role; existing role-wide choices are preserved.

Pickup events contain only the claim reference and pickup location; claimant information and ownership-verification details are never added. Calendar events use a deterministic ID so retry and reschedule operations update the same event. Calendar provider errors do not reverse claim decisions. Staff can retry failed syncs; reject, item removal, and item return clean up linked events. Claimants receive pickup details and a local Google Calendar template link in the in-app notification and, when SMTP is enabled, by email. The template link and `.ics` download do not require Calendar API availability.

After confirming the settings in Admin → Settings and testing the integrations, the migrated environment variables can be removed from `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `API_GOOGLE_REDIRECT_URI`, `GOOGLE_REDIRECT_URI`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. These remain temporary fallbacks only when the corresponding MongoDB field is empty. Keep `INTEGRATION_ENCRYPTION_KEY`; it is required to decrypt database secrets. Keep `API_PORT` if you use it; otherwise the callback URL is stored during migration using its current value/default.

Integration Settings has a separate server-side PIN gate. Set `SU_PIN` to a private random value and `SU_EMAIL` to the administrator inbox that receives verification and restore notices. To generate and configure the PIN in PowerShell:

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

1. Run the command from the project folder (any folder with Node.js available also works).
2. Copy the entire value printed by the command, without adding quotes or spaces.
3. Paste it after `SU_PIN=` in the root `.env` file, for example: `SU_PIN=<paste-the-generated-value>`.
4. Save `.env` and restart the API with `npm.cmd start`.

This value is the Integration Settings PIN, not the `INTEGRATION_ENCRYPTION_KEY`. Keep it private and do not commit `.env` to source control. `SU_PIN` remains the same until you change it in `.env`; restarting the API is required for a changed value to take effect.

Verification and restore notices use only the independent `SU_SMTP_*` bootstrap account, never the editable SMTP integration or its fallback variables. Copy these values from the existing settings before removing any old variables:

| New variable | Copy from |
|---|---|
| `SU_SMTP_HOST` | `SMTP_HOST` |
| `SU_SMTP_PORT` | `SMTP_PORT` |
| `SU_SMTP_SECURE` | `SMTP_SECURE` |
| `SU_SMTP_USER` | `SMTP_USER` |
| `SU_SMTP_PASSWORD` | `SMTP_PASSWORD` |
| `SU_SMTP_FROM` | `SMTP_FROM` |

Set `SU_SMTP_SECURE=false` explicitly when the old value is unset but the server uses STARTTLS on port 587. All six `SU_SMTP_*` variables and `SU_EMAIL` must be configured for code delivery. If bootstrap mail is incomplete, Integration Settings remains usable for non-credential changes, but credential changes are blocked with a configuration message; the rest of the application continues to work. Do not remove the old `SMTP_*` values until you have confirmed both verification-code and restore-notice emails arrive. `.env` is ignored by Git; keep it private and do not commit it.

Verification-code throttling can be adjusted with `SU_CODE_REQUEST_LIMIT` (default `5` requests), `SU_CODE_REQUEST_WINDOW_SECONDS` (default `3600` seconds), and `SU_CODE_RESEND_SECONDS` (default `60` seconds between sends). For local testing, for example, set them to `20`, `60`, and `1`; restore the defaults before deployment. Values must be positive whole numbers, and changing them requires restarting the API.

Settings write and test limits are stored in MongoDB and shared across API instances: 100 settings requests per account per 10 minutes overall; 10 saves/code actions, 10 connection tests, and 5 default/restore actions per account+IP; 10 verifies per account+integration. Those specific limits use 10-minute windows. Settings reads are limited to 60 per account per minute in memory. PIN, emailed-code, failed-send, test-email, and MFA lockouts retain their existing thresholds and use MongoDB. Five failed integration validations in 10 minutes trigger a 5-minute per-integration cooldown. Write-control store failures return a safe retryable error; settings reads fail open. Login sessions are also stored in MongoDB, so a MongoDB outage already prevents normal login.

Integration card changes remain pending until saved. Credential changes (including client IDs and SMTP usernames) require a one-use six-digit email code before any values in that Save Changes request are written. PIN unlocks expire after 10 minutes of inactivity and are cleared when leaving the settings page or signing out. Environment migration creates an encrypted-secret default snapshot; later defaults are only set by a successful saved SMTP test or an explicit admin action. Restoring a default sends a field-name-only notice through the bootstrap account when configured.

The **Admin MFA** card uses locally generated TOTP codes; no external MFA service is involved. Admins enroll from **Security** with an authenticator app and must save the eight recovery codes somewhere safe because they are shown only once. The server stores encrypted TOTP secrets and hashed recovery codes. Turning MFA off, or changing **Require for all admins** from on to off, requires both the Integration Settings PIN and an emailed verification code. `ADMIN_MFA_DISABLED=true` is an emergency login bypass (default `false`); it skips MFA enforcement but does not delete enrollments. `ADMIN_MFA_RATE_LIMIT_DISABLED=true` temporarily disables MFA attempt limits for local testing only; it is ignored when `NODE_ENV=production`. The API prints a warning when either bypass applies. Keep both settings `false` outside local testing and return them to `false` after testing.

TOTP codes are derived from the server's Unix time in 30-second steps. If the server clock is significantly ahead or behind, valid codes may be rejected; keep the server synchronized with a trusted time source. On Windows, check synchronization with `w32tm /query /status` and resynchronize from an elevated PowerShell with `w32tm /resync`. On Linux systems using systemd, check with `timedatectl status` and enable synchronization with `timedatectl set-ntp true`. The configured MFA window tolerates at most one neighboring 30-second step by default, and a code cannot be reused.

When an enabled integration has a provider, credential, network, or timeout failure, the API returns a safe temporary-unavailable message and records a sanitized failure in the integration card. The card shows the last failure time, safe reason, and consecutive failure count; a successful provider call or connection test clears the failure. Calendar sync failures are separately rate-limited in the audit log and expose only claim and event IDs. Disabled integrations are skipped without being marked as failing. Invalid or expired user CAPTCHA challenges and cancelled Google sign-ins do not count as integration failures. Password-reset requests always return the same generic response, while SMTP delivery failures are logged and recorded in SMTP health. Bootstrap email failures are logged separately and do not affect the editable SMTP card.

Admin and staff mutations write audit events through `src\services\audit-log.js`. Replica-set or sharded MongoDB deployments use a transaction for the action and its audit row. Standalone MongoDB uses the specified fallback: critical actions first append an `attempted` event, then finalize only that event as `success` or `failed`. The Admin-only **System Records** page is newest-first, server-filtered, and paginated at 25 rows. It is read-only.

The application does not write passwords, tokens, session IDs, request bodies, or claimant ownership details to audit records. Item removal is a soft delete; normal item and claim screens omit deleted records, while System Records retains the item’s safe identifying summary.

If there is no active admin account, create the minimal permission-management admin with `npm.cmd run seed:admin`. Set `ADMIN_EMAIL`, `ADMIN_FULL_NAME`, and `ADMIN_PASSWORD` in the process environment first; the password must be at least 12 characters. The script will not promote an existing non-admin account or replace an existing admin password.

## Ports and environment

- `FRONTEND_PORT` changes the frontend port (default `5173`).
- `API_PORT` changes the API port (default `3001`).
- `TRUST_PROXY` defaults to `false`. Set it to a hop count (for example, `1`) or a comma-separated list of trusted proxy CIDRs only when the API is behind those proxies. Do not set it to `true`; an incorrect value can make client IP-based protections trust forwarded headers.
- The API-wide guard is 1,500 requests per IP per 15 minutes; the global guard and integration-call token buckets are process-local, so their effective allowance is per instance. Auth, settings-write, and session data are stored in MongoDB and shared across API instances using the same database and session configuration. MongoDB outages also disrupt login because sessions are stored there.
- `API_BASE_URL` changes the API URL used by the frontend.
- `FRONTEND_ORIGIN` sets the allowed frontend origin for credentialed API requests (default `http://localhost:5173`).
- `API_GOOGLE_REDIRECT_URI` sets the callback URL for Google sign-in. For compatibility with existing `.env` files, `GOOGLE_REDIRECT_URI` is also accepted. If both are set, `API_GOOGLE_REDIRECT_URI` takes precedence. If neither is set, the API derives the callback from `API_PORT` (default `http://localhost:3001/api/auth/google/callback`).

For Google sign-in, use a **Web application** OAuth client and add this exact URL under **Authorized redirect URIs** in Google Cloud Console:

```text
http://localhost:3001/api/auth/google/callback
```

If you change `API_PORT` or set either redirect URI variable, register the resulting API callback instead. The Google Console value and the callback sent by the API must match exactly, including protocol, host, port, and path. Restart the backend after changing the environment.

## Rate limits

The API-wide flood guard allows 1,500 requests per IP per 15 minutes. Route-level groups are configured centrally and shown in Admin → Settings → **Rate limits** after an administrator passes the existing `manage_integrations` permission and PIN gate.

| Module | Configured route limits | Storage |
|---|---|---|
| Public and auth | Registration 20/IP/hour; login 10 failed attempts/IP+email/15 min; forgot password 10/IP and 5/email/hour; reset 10/IP/hour; Google sign-in 20/IP/min; MFA login 20/IP/min | MongoDB |
| User | Reads 120/account/min; images 600/account/min; report create 20/account+IP/hour; edit/cancel 30/account+IP/hour; uploads 20/account+IP/hour; claims 10/account+IP/hour and 3/account+item/day; profile edits 10/account+IP/hour; notification reads 120/account/min and writes 60/account+IP/min | Read/image groups in per-instance memory; writes in MongoDB |
| Staff | Reads 240/account/min; images 600/account/min; writes 60/account+IP/min; calendar retries 10/account+IP/10 min | Read/image groups in per-instance memory; writes in MongoDB |
| Admin | Reads 240/account/min; images 600/account/min; account writes 30/account+IP/10 min; role/permission writes 20/account+IP/10 min; item writes 30/account+IP/10 min; inventory 10/account/min; System Records 60/account/min | Read/image groups in per-instance memory; writes in MongoDB |
| Settings and security | Overall 100/account/10 min; saves/code actions and tests 10/account+IP/10 min; verifies 10/account+integration/10 min; defaults 5/account+IP/10 min; reads 60/account/min; MFA enrollment 10/account+IP/10 min | Reads in per-instance memory; write groups and PIN/code/MFA lockouts in MongoDB |
| Integrations | Five failed validations per integration in 10 min trigger a 5 min cooldown | MongoDB; each integration card’s “Calls per minute” bucket remains per-instance memory |

Authenticated routes key limits to the session user ID, not a request-supplied identity. Read groups are per account; writes generally use account+IP. Public routes use IP, with email additionally used for login and the forgot-password email cap. IPv4-mapped IPv6 addresses are normalized and IPv6 clients are keyed by /64. MongoDB-backed counters are shared across API instances; memory counters are per instance.

Additional MongoDB controls include five failed Settings PIN attempts before a 15-minute lockout; emailed-code requests (default 5/hour, configurable with `SU_CODE_REQUEST_LIMIT` and `SU_CODE_REQUEST_WINDOW_SECONDS`), a resend cooldown (default 60 seconds, configurable with `SU_CODE_RESEND_SECONDS`), five code attempts before expiry, 10 failed code-email sends/hour, and three test emails/hour. Admin MFA locks after five failed attempts in its 15-minute window for 15 minutes. The Settings table displays their effective values and whether they come from defaults or environment configuration. Sessions are also stored in MongoDB, so a MongoDB outage already disrupts login.

`TRUST_PROXY` defaults to `false`. Set it only to the actual trusted proxy hop count or comma-separated trusted proxy CIDRs; plain `true` is not accepted. The explicit route-level exemptions are `GET /health`, `GET /auth/me`, and `POST /auth/logout`. The global flood guard also skips `OPTIONS` and `GET /health`.

## Concurrency control: Locking

The API uses MongoDB-backed pessimistic locks across instances. Lock acquisition order is `roster → role → integration → account → item → claim → slot`, with IDs sorted within each type. Shared (S) locks are compatible only with S; exclusive (X) locks are incompatible with all live locks. Each lease expires after `LOCK_LEASE_MS` (default 30 seconds), and acquisition waits no longer than `LOCK_WAIT_MS` (default 3 seconds). `LOCK_RETRY_MIN_MS` and `LOCK_RETRY_MAX_MS` bound retry backoff; `LOCK_MAX_PER_REQUEST` defaults to five. `LOCK_DEMO_HOLD_MS` can add a local-only delay inside a critical section; it is ignored with a warning in production. TTL indexes are cleanup only—expired leases are judged against the database clock.

Integration X locks are held only while applying saved configuration, setting a default, restoring a default, or applying a code-verified save. Provider validation and emailed-code entry happen without an integration lock; the stored configuration is rechecked under lock before writes. Password reset and administrator MFA enrollment/recovery changes take X on the affected account. Calendar work is a separate short action under X on the claim after approval/pickup locks are released.

The following operations intentionally do not acquire record locks:

| Route or operation | Reason |
|---|---|
| Google OAuth callback | Part of the authentication lifecycle; callback state and code verification govern completion. |
| Item and user creation | Operates on new IDs; database uniqueness constraints protect duplicate unique values. |
| Notification read markers | Per-user read state, not shared business-record state. |
| Session routes, login, and logout | Authentication lifecycle operations. |
| Forgot-password request | Creates/replaces a one-time reset token; the subsequent password reset is account-locked. |

## API examples

- `GET /api/items` lists and searches browseable items for signed-in Users with the corresponding role permissions. Admins can access it; signed-out visitors are directed to sign in.
- `POST /api/items` creates a lost/found report.
- `GET /api/items/:id` retrieves item details for signed-in Users with `view_items` (or Admins).
- `GET /api/items/:id/image` serves an eligible public lost-item image through the permission-checked API.
- `GET /api/staff/items/:id/image` serves a report image after checking that staff member's permission; admins can access this route too.
- `GET /api/admin/items/:id/image` retrieves a private found-item image for admins.
- `POST /api/auth/login` signs in and starts an API session.
- `GET /api/auth/me` returns the signed-in user and frontend configuration.
- `GET /api/staff/claims` lists claims for staff review.

Found-item images are private: public item responses do not expose their image paths. Use the protected staff/admin image endpoints. Lost-item images are served through `/api/items/:id/image` instead of a static uploads URL.

Staff permissions are loaded from MongoDB on every staff API request. `GET /api/staff/records` is a read-only summary view; detailed claim data requires `view_claims`. Permission changes and denied access are recorded in the general audit log. System Records is available only to admins.

The API sends JSON responses and uses cookie-based sessions. The browser frontend includes those session cookies when it calls the API. Google sign-in redirects through `/api/auth/google` and returns through `/api/auth/google/callback`.

Run the API route checks with `node --test backend\tests\api.test.js` or `npm.cmd test`.

The archived PHP and EJS implementations are retained for reference and are not used by the current two-port setup.