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

It copies non-empty environment settings into MongoDB, encrypts secret fields, preserves existing Google/reCAPTCHA enabled states, and sets SMTP enabled only when the SMTP environment configuration is complete. It logs integration IDs and field names, never values. The Admin page then supports pending edits, Save Changes, Cancel, field-level validation, and masked secrets. SMTP **Test Connection** verifies the current form values without sending an email.

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

Integration card changes remain pending until saved. Credential changes (including client IDs and SMTP usernames) require a one-use six-digit email code before any values in that Save Changes request are written. PIN unlocks expire after 10 minutes of inactivity and are cleared when leaving the settings page or signing out. Environment migration creates an encrypted-secret default snapshot; later defaults are only set by a successful saved SMTP test or an explicit admin action. Restoring a default sends a field-name-only notice through the bootstrap account when configured.

When an enabled integration has a provider, credential, network, or timeout failure, the API returns a safe temporary-unavailable message and records a sanitized failure in the integration card. The card shows the last failure time, safe reason, and consecutive failure count; a successful provider call or connection test clears the failure. Calendar sync failures are separately rate-limited in the audit log and expose only claim and event IDs. Disabled integrations are skipped without being marked as failing. Invalid or expired user CAPTCHA challenges and cancelled Google sign-ins do not count as integration failures. Password-reset requests always return the same generic response, while SMTP delivery failures are logged and recorded in SMTP health. Bootstrap email failures are logged separately and do not affect the editable SMTP card.

Admin and staff mutations write audit events through `src\services\audit-log.js`. Replica-set or sharded MongoDB deployments use a transaction for the action and its audit row. Standalone MongoDB uses the specified fallback: critical actions first append an `attempted` event, then finalize only that event as `success` or `failed`. The Admin-only **System Records** page is newest-first, server-filtered, and paginated at 25 rows. It is read-only.

The application does not write passwords, tokens, session IDs, request bodies, or claimant ownership details to audit records. Item removal is a soft delete; normal item and claim screens omit deleted records, while System Records retains the item’s safe identifying summary.

If there is no active admin account, create the minimal permission-management admin with `npm.cmd run seed:admin`. Set `ADMIN_EMAIL`, `ADMIN_FULL_NAME`, and `ADMIN_PASSWORD` in the process environment first; the password must be at least 12 characters. The script will not promote an existing non-admin account or replace an existing admin password.

## Ports and environment

- `FRONTEND_PORT` changes the frontend port (default `5173`).
- `API_PORT` changes the API port (default `3001`).
- `API_BASE_URL` changes the API URL used by the frontend.
- `FRONTEND_ORIGIN` sets the allowed frontend origin for credentialed API requests (default `http://localhost:5173`).
- `API_GOOGLE_REDIRECT_URI` sets the callback URL for Google sign-in. For compatibility with existing `.env` files, `GOOGLE_REDIRECT_URI` is also accepted. If both are set, `API_GOOGLE_REDIRECT_URI` takes precedence. If neither is set, the API derives the callback from `API_PORT` (default `http://localhost:3001/api/auth/google/callback`).

For Google sign-in, use a **Web application** OAuth client and add this exact URL under **Authorized redirect URIs** in Google Cloud Console:

```text
http://localhost:3001/api/auth/google/callback
```

If you change `API_PORT` or set either redirect URI variable, register the resulting API callback instead. The Google Console value and the callback sent by the API must match exactly, including protocol, host, port, and path. Restart the backend after changing the environment.

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
