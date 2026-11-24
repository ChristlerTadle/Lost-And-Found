# BukSU Lost and Found

The current application has a separate static frontend and Express REST API. Both use the existing MongoDB data and shared backend services. The archived PHP and EJS implementations are retained under `archived/` for reference and are not part of the current run setup.

## Requirements

- Node.js 20 or newer
- MongoDB Community Server

## Run locally

From PowerShell in the project folder, install dependencies once:

```powershell
npm.cmd install
```

Start MongoDB, then open two PowerShell windows at the project root.

Start the REST API:

```powershell
npm.cmd start
```

Start the frontend in the second window:

```powershell
npm.cmd run start:frontend
```

Open `http://localhost:5173`. The frontend calls the API at `http://localhost:3001/api` by default. See [REST-SETUP.md](./REST-SETUP.md) for ports, environment settings, and Google OAuth setup.

## Rate limits

| Module | Examples | Counter storage |
|---|---|---|
| Public and auth | API flood guard: 1,500/IP/15 min; registration: 20/IP/hour; login: 10 failed attempts/IP+email/15 min; forgot password: 10/IP and 5/email per hour | MongoDB, except the global flood guard (per-instance memory) |
| User | Reads: 120/account/min; item images: 600/account/min; reports: 20 creates and 30 edits/cancellations per account+IP/hour; claims: 10/account+IP/hour and 3/account+item/day | Read/image groups in per-instance memory; writes in MongoDB |
| Staff | Reads: 240/account/min; images: 600/account/min; writes: 60/account+IP/min; calendar retry: 10/account+IP/10 min | Read/image groups in per-instance memory; writes in MongoDB |
| Admin | Reads: 240/account/min; images: 600/account/min; account writes: 30/account+IP/10 min; role/permission writes: 20/account+IP/10 min; inventory: 10/account/min | Read/image groups in per-instance memory; writes in MongoDB |
| Settings and security | Overall: 100/account/10 min; saves and tests: 10/account+IP/10 min; verifies: 10/account+integration/10 min; defaults: 5/account+IP/10 min; settings reads: 60/account/min | Settings reads in per-instance memory; write limits and PIN, code, and MFA controls in MongoDB |
| Integrations | Five failed validations per integration in 10 min trigger a 5 min cooldown | MongoDB; integration-card “Calls per minute” buckets remain per-instance memory |

Authenticated route limits use the session user ID; reads are per account and writes generally combine account+IP. Public routes use IP, with email added for login and the forgot-password email cap. IPv4-mapped addresses are normalized and IPv6 clients are grouped by /64. `TRUST_PROXY` defaults to `false`; configure a trusted proxy hop count or CIDR list only when the API is behind those proxies. Do not set it to `true`.

The route-level exemptions are `GET /health`, `GET /auth/me`, and `POST /auth/logout`. The global API guard also bypasses `OPTIONS` and `GET /health`. The full live configuration is available in Admin → Settings → **Rate limits** after PIN unlock and permission checks. MongoDB also stores sessions, so an outage already disrupts login.

## Concurrency control: Locking

Shared-record mutations use pessimistic MongoDB locks. Locks are acquired in the global order `roster → role → integration → account → item → claim → slot`, with IDs sorted within each type. Shared locks coexist only with shared locks; an exclusive lock conflicts with every live lock. Leases expire even if MongoDB's TTL cleanup has not run, and a bounded wait returns a conflict rather than waiting indefinitely. The environment settings and defaults are listed in [REST-SETUP.md](./REST-SETUP.md).

Integration locks cover only the apply phase; provider validation and emailed-code entry happen before acquiring them. Calendar sync retries are separately locked by claim after approval or pickup locks have been released. Password reset and administrator MFA mutations lock the affected account.

These mutations intentionally remain outside the lock plan:

| Route or operation | Reason |
|---|---|
| Google OAuth callback | Authentication lifecycle; callback state and code verification govern completion. |
| Item and user creation | New record IDs and database uniqueness constraints prevent same-record updates from racing. |
| Notification read markers | Per-user read state, not shared business-record state. |
| Session routes, login, and logout | Authentication lifecycle operations. |
| Forgot-password request | Creates/replaces a one-time reset token; the subsequent password reset is account-locked. |

## Project layout

- `frontend/`: static browser application and frontend server
- `backend/`: REST API server, routes, controllers, middleware, and API tests
- `src/`: MongoDB connection and shared application services used by the API
- `assets/app.css`: shared stylesheet used by the frontend
- `uploads/` and `private_uploads/`: item image storage
- `archived/`: previous implementations and utilities retained for reference

Run the API tests with:

```powershell
npm.cmd test
```
