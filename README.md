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

The route-level exemptions are `GET /health`, `GET /auth/me`, and `POST /auth/logout`. The global API guard also bypasses `OPTIONS`, `GET /health`, and edit-session renewals. The full live configuration is available in Admin → Settings → **Rate limits** after PIN unlock and permission checks. MongoDB also stores sessions, so an outage already disrupts login.

## Concurrency control: Locking

Shared-record mutations use pessimistic MongoDB locks across API instances. Each multi-lock request is sorted by one helper in this global order: `roster -> role -> integration -> account -> item -> claim -> slot`; IDs are sorted within a resource type. `slot:<date>-<time bucket>` serializes scheduling only; it does not impose capacity or change scheduling rules.

| Resource key | Mode | Routes that take the lock | Order |
|---|---|---|---|
| `roster` | X | Admin account changes involving an admin (including role/enable/disable and permission changes); `PUT /api/admin/role-permissions/admin` | 1 |
| `role:<name>` | X | `PUT /api/admin/role-permissions/:role` | 2 |
| `integration:<id>` | X | Apply phase of `PUT /api/admin/settings` and `POST /api/admin/settings/code/verify`; `POST /api/admin/settings/:integrationId/default` and `/restore-default` | 3 |
| `account:<id>` | S | `POST /api/claims` for the submitter; `PATCH /api/staff/claims/:id` and `/pickup` for the claimant | 4 |
| `account:<id>` | X | `PATCH /api/admin/users/:id`, `PUT/DELETE /api/admin/users/:id/permissions`, `PATCH /api/profile`, `POST /api/auth/reset-password`, and admin MFA enrollment/recovery changes | 4 |
| `item:<id>` | X | `POST /api/claims`; staff claim review/pickup; staff item status/verify; admin item edit/remove; user report edit/cancel/resolve; edit sessions for admin Edit item and staff Review item | 5 |
| `claim:<id>` | X | Staff claim approve/reject/returned, pickup, and separate calendar-sync action; staff claim-details edit session | 6 |
| `slot:<date>-<time bucket>` | X | Staff claim approval when scheduling a pickup; `PATCH /api/staff/claims/:id/pickup` | 7 |

Claim submit and claim approval/rejection/return/pickup also take S on the claimant's account. Approval/rejection/return take X on the item and claim; pickup adds X on the slot. The approval/pickup locks are released before the external calendar call. Calendar sync is a separate short action under X on the claim and does not undo an approval if the provider call fails. Account/admin roster locks are acquired before item, claim, or slot locks, regardless of the order in which a route lists them.

Integration provider validation and the emailed-code wait occur without an integration lock. The apply phase locks the affected integration IDs, re-reads the saved configuration, and returns `409 state_conflict` if it differs from the configuration that was validated. Calendar provider calls are time-limited below the action-lock lease.

| Compatibility | S | X |
|---|---:|---:|
| S | Compatible | Conflicts |
| X | Conflicts | Conflicts |

S is used for claimant-account reads that a claim decision depends on. Changes use X. Under strict two-phase locking, a request acquires its complete lock set before the critical section, re-reads records and validates derived IDs, `deleted_at`, and current status while locked, performs its writes, and releases locks in `finally` on success or error. If a lock is lost before a final write, that write is aborted. Edit sessions hold their X locks while the form is open; a save borrows the same lock only with a valid account-bound token. A direct action request without a token still takes its normal short action locks.

The deadlock-prevention order is global, not caller-selected; the sorting helper sorts IDs within each type. For example, one request may ask for `claim:7` then `item:42`, while another asks for `item:42` then `claim:7`. Both are actually acquired as `item:42` then `claim:7`, so the requests cannot form an opposite-order cycle.

Lock leases use database/server time, not TTL cleanup. Defaults: `LOCK_LEASE_MS=30000`, `LOCK_WAIT_MS=3000`, retry backoff `LOCK_RETRY_MIN_MS=20` to `LOCK_RETRY_MAX_MS=120`, and `LOCK_MAX_PER_REQUEST=5`. `LOCK_DEMO_HOLD_MS=0` adds no delay by default; a positive value adds a delay inside a critical section for local demos and is ignored with a warning in production. Edit-session leases are 60 seconds, renewed every 20 seconds while the page is visible; a competing editor may retry every 15 seconds. If MongoDB is unavailable, lock acquisition fails closed with a safe service-unavailable response; the handler does not run unlocked.

```mermaid
sequenceDiagram
    participant A as Staff A
    participant B as Staff B
    participant API
    participant DB as MongoDB locks and records
    A->>API: Approve claim 7
    API->>DB: Acquire account S, item 42 X, claim 7 X
    DB-->>API: Locks acquired
    API->>DB: Re-read item and claim; validate status and deleted_at
    B->>API: Approve claim 7
    API->>DB: Request same locks in global order
    DB-->>API: Wait while A holds item/claim X
    API->>DB: Write approval; release all locks in finally
    DB-->>B: Locks become available
    API->>DB: Re-read state under locks
    DB-->>API: Claim already approved
    API-->>B: 409 state_conflict
```

```mermaid
sequenceDiagram
    participant A as Editor A
    participant B as Editor B
    participant UI as API and lock manager
    A->>UI: Acquire form lock
    UI-->>A: X lock, token, 60s expiry
    loop Every 20s while visible
        A->>UI: Renew with token
        UI-->>A: Extended expiry
    end
    B->>UI: Acquire same form lock
    UI-->>B: 409; read-only with holder banner
    Note over A,UI: If A closes, crashes, or sleeps, renewals stop
    UI-->>UI: Lease expires by database time
    B->>UI: Retry after expiry
    UI-->>B: New X lock and token
```

Long forms use exclusive edit-session locks: admin Edit item (`item:<id>`), admin Edit user (`account:<id>` and `roster` when the target is an admin), staff Review item (`item:<id>`), and staff claim details (`item:<id>` then `claim:<id>`). `POST /api/locks/acquire`, `/renew`, and `/release` derive keys from the form type and record ID; clients cannot choose keys. These routes require CSRF and the existing permission for that form. Heartbeats use `lock_heartbeat` (30 per account per minute), are not audited, and renewals bypass the global API counter. Only acquire/release and lock conflict/timeout/expired takeover events are audited; tokens are not logged. Competing editors get a read-only form and can retry; a missing, expired, or foreign save token returns `lock_lost` without discarding typed input.

### Manual two-browser demo

Use a non-production environment with a test account for each role. Set `LOCK_DEMO_HOLD_MS` to a short value below the 30-second action lease and restart the API; do not enable this in production. Sign in as the named roles in two separate browsers.

1. **Same-claim approval:** have both staff users approve the same pending claim at nearly the same time. One should succeed; the other should wait, re-read, and receive a clear `409 state_conflict` rather than duplicate the approval.
2. **Admin removal versus approval:** race an admin's item removal against staff approval of a claim on that item. The locks serialize them; removal must not allow a deleted item to be approved.
3. **Two-admin demotion:** have two active admins demote each other simultaneously. At least one active admin retaining `manage_permissions`, `view_users`, and `manage_integrations` must remain; the losing change receives a conflict/last-admin error.
4. **Edit-session contention and expiry:** open the same edit form in both browsers. The second is read-only while the first renews. Stop renewals by closing or sleeping the first tab, wait beyond the 60-second lease, then retry in the second browser; it should acquire the lock.
5. **Stale integration plan:** begin an integration validation/code-verification flow, change the saved integration configuration in the other browser while waiting for the emailed code, then submit the code. Applying the stale plan should return `409 state_conflict`; validate and verify the new configuration instead.

After the demo, unset `LOCK_DEMO_HOLD_MS` (or set it to `0`) and restart the API.

### Known limits and intentionally unlocked routes

The supported deployment here is standalone MongoDB: atomic single-document lock operations are used, but there are no multi-document transactions. Fixed leases can expire during a stalled process; edit-session heartbeats extend them, and a lost action lock aborts its final write. Locks serialize existing behavior; they do not add item capacity, scheduling, or other business rules. Routine read-only routes do not need record locks.

| Route or operation | Why it is outside this lock plan |
|---|---|
| Google OAuth callback (`GET /api/auth/google/callback`) | Authentication lifecycle; callback state and code verification govern completion. |
| Item and user creation (`POST /api/items`, `POST /api/admin/users`) | Creates new record IDs; database uniqueness constraints protect duplicate unique values. |
| Notification read markers | Per-user read state, not shared business-record state. |
| Session routes, login, and logout | Authentication lifecycle operations. |
| Forgot-password request (`POST /api/auth/forgot-password`) | Creates/replaces a one-time reset token; the subsequent password reset is account-locked. |

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


## Project Contributors

This project was developed through teamwork and collaboration.

- IanPatuasic – Contributor
- ChristlerTadle - Contributor
- MichaelRoselim - Contributor
- Kathleen4696 - Contributor