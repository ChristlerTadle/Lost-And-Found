# BukSU Lost and Found

Lost and found application built with Node.js, JavaScript, Express, EJS, and MongoDB.

## Requirements

- Node.js 20 or newer
- MongoDB Community Server
- MongoDB Compass (GUI for connecting to and inspecting MongoDB)
- MySQL/XAMPP only if importing existing MySQL data

The Node app does not require Composer, a PHP MongoDB extension, or Apache. The previous PHP implementation is preserved under `legacy/php/` and is not used by the Express server. MySQL schema files remain under `database/` as references for the existing source database.

## Run locally

From PowerShell in the project folder:

```powershell
Set-Location 'C:\xampp\htdocs\php_conversion'
Copy-Item .env.example .env
npm.cmd install
npm.cmd start
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` as shown. Open `http://localhost:3000`.

Start MongoDB Community Server first. The default connection is `mongodb://127.0.0.1:27017`, and the default database name is `lost_and_found`. Edit `.env` to change these values and set a long random `SESSION_SECRET` before deployment.

The app creates these collections and indexes automatically when it connects:

- `users`: accounts, password hashes, and roles
- `password_resets`: hashed, one-time password reset tokens that expire after one hour
- `lost_items`: lost/found reports and optional lost-item image paths
- `item_claims`: ownership claims and review status
- `sessions`: Express login sessions

Connect MongoDB Compass to `mongodb://127.0.0.1:27017`, then refresh to inspect the `lost_and_found` database after the app connects or data is imported.

## Import existing MySQL data

Back up the MySQL database first. Keep MySQL running, then configure the `MYSQL_SOURCE_*` values in `.env`. Run:

```powershell
npm.cmd run import:mysql
```

The script asks you to type `IMPORT` before writing. It upserts users, item reports, and claims into MongoDB by their existing IDs; it does not change or delete MySQL data. It preserves saved image paths and reconnects legacy uploaded photos named `<report-id>.<extension>` from `uploads/lost/`. It is safe to inspect the target database in Compass after it completes. Rerunning it replaces MongoDB documents with matching IDs using the current MySQL values.

## Features

- Register, sign in, and manage profiles
- Enable or disable configured Google sign-in from the admin settings page
- Report lost or found items
- Upload an optional image for lost-item reports
- Edit and cancel active reports
- Browse, search, and filter items
- Submit claims for found items and view claim status
- Prevent users from claiming their own reports or submitting duplicate claims
- Keep identifying details private on public item pages
- Give staff a private queue for reviewing lost-item reports and found items
- Let staff mark found items as physically verified and approve or reject ownership claims
- Mark approved found items as claimed, remove them from active browsing, and retain their report history
- Reject and notify other pending claimants when an item is awarded, and notify the reporter and approved claimant
- Reset forgotten passwords using one-time links sent by SMTP email

To enable password reset email, configure `APP_BASE_URL` with the public application URL and set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `SMTP_FROM` in `.env`. If the SMTP server requires authentication, also set `SMTP_USER` and `SMTP_PASSWORD`. Use `SMTP_SECURE=true` for an implicit-TLS connection (typically port 465); use `false` for STARTTLS (typically port 587).

To enable Google sign-in, create an OAuth 2.0 **Web application** client in the Google Cloud Console. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI for local development, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Set `GOOGLE_REDIRECT_URI` to the exact authorized callback URI (for example, `https://your-domain/auth/google/callback` in production). Keep the client secret private and use HTTPS in production. The button appears after both credentials are configured. Google accounts with a verified email are matched to an existing account by email or create a regular user account; staff/admin access remains controlled by the app's existing role assignment.

After setting Google OAuth credentials, an administrator can enable or disable Google sign-in under **Settings** in the admin navigation. The integration remains inactive until both the credentials are configured and the admin toggle is enabled.

## Structure

- `server.js`: Express startup, middleware, helpers, and view configuration
- `src/routes/`: page routing
- `src/services/`: authentication and MongoDB business operations
- `src/db.js`: MongoDB connection and indexes
- `views/`: EJS templates
- `assets/`: shared styles and browser JavaScript
- `scripts/import-mysql.js`: confirmed MySQL-to-MongoDB importer
- `uploads/`: stored lost-item images
- `legacy/php/`: archived PHP implementation retained for reference
