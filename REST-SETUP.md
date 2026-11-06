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

The Admin **Settings** page stores Google OAuth, reCAPTCHA, and SMTP settings in the existing MongoDB `integration_settings` collection. Integration secrets are encrypted with AES-256-GCM. Before starting the updated API, create a stable encryption key and put it in the root `.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the output as `INTEGRATION_ENCRYPTION_KEY`. Keep a secure backup of this key; do not put it in MongoDB or source control. The API fails at startup if the key is missing or malformed, and reports a clear startup error if it cannot decrypt stored secrets. Losing the key makes existing encrypted settings unrecoverable; restore the key backup or re-enter the integration credentials.

With the key set and the previous integration environment variables still present, run the idempotent migration before starting the API:

```powershell
npm.cmd run migrate:integrations
```

It copies non-empty environment settings into MongoDB, encrypts secret fields, preserves existing Google/reCAPTCHA enabled states, and sets SMTP enabled only when the SMTP environment configuration is complete. It logs integration IDs and field names, never values. The Admin page then supports pending edits, Save Changes, Cancel, field-level validation, and masked secrets. SMTP **Test Connection** verifies the current form values without sending an email.

After confirming the settings in Admin → Settings and testing the integrations, the migrated environment variables can be removed from `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `API_GOOGLE_REDIRECT_URI`, `GOOGLE_REDIRECT_URI`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. These remain temporary fallbacks only when the corresponding MongoDB field is empty. Keep `INTEGRATION_ENCRYPTION_KEY`; it is required to decrypt database secrets. Keep `API_PORT` if you use it; otherwise the callback URL is stored during migration using its current value/default.

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
