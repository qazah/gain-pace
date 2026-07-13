# Garmin Connection + Live Data Fetch (S-01) Implementation Plan

## Overview

Implement roadmap slice **S-01** (north star): a logged-in runner connects their Garmin
account (username/password + MFA) and sees, fetched live, today's scheduled workout, their last
3–4 activities, and recovery metrics (sleep quality, HRV, Body Battery).

Web research already falsified the original assumption that Garmin can be called directly from
Cloudflare Workers: since March 2026 Garmin's SSO sits behind Cloudflare JA3/JA4 TLS
fingerprinting, which `403`s every non-browser TLS client — including a Worker's `fetch()`. The
only viable path is an **off-edge sidecar**: a small free Node service (Koyeb) running
`garmin-connect-client` (orpjones v2.0.0) that performs the TLS-impersonated SSO login + OAuth2
token refresh and owns all Garmin I/O, exposing a clean JSON API the Worker calls over HTTPS.

## Current State Analysis

- **Runtime is confirmed Cloudflare Workers SSR (V8 isolate).** `astro.config.mjs:11,16`
  (`output: "server"`, `adapter: cloudflare()`); `wrangler.jsonc:6-8` (`nodejs_compat`).
  `nodejs_compat` does **not** load native C/C++ addons → `node-libcurl-ja3` cannot run
  in-Worker. No child processes / browser → confirms the sidecar requirement.
- **F-01 (domain-schema) is done and committed.** `garmin_credentials` exists with RLS
  (`supabase/migrations/20260604000001_create_domain_tables.sql:40-60`) — per-user policies on
  all four ops, `anon` revoked, `UNIQUE (user_id)`. Row type generated at
  `src/types/database.ts:23-53`, re-exported as `GarminCredentials` (`src/types.ts:4`).
- **Schema gap:** `garmin_credentials` holds only scalar OAuth2 fields (`access_token`,
  `refresh_token`, `expires_at`). It cannot store `garmin-connect-client`'s `PersistedSession`
  (OAuth1 + OAuth2 + cookies). `workout_selections` already uses a `garmin_data_snapshot JSONB`
  column, so JSONB is an established pattern here.
- **Per-user Supabase client** is created from cookies (`src/lib/supabase.ts:6,10`,
  `createServerClient<Database>`), returns `null` when env missing (callers must null-check). RLS
  auto-scopes to `auth.uid()`.
- **Middleware** attaches `context.locals.user` (`src/middleware.ts:6-16`); `PROTECTED_ROUTES =
  ["/dashboard"]` (`:4`). `/api/garmin/*` is **not** auto-protected → routes must check
  `locals.user` themselves.
- **Env/secrets** are declared via `envField` in `astro.config.mjs:17-22` (`context:"server",
  access:"secret", optional:true`) and read with `import { … } from "astro:env/server"` — never
  `process.env`. Only `SUPABASE_URL`, `SUPABASE_KEY` today.
- **Config banners:** `src/lib/config-status.ts:11-21` is a registry of `{name, configured,
  message, docsUrl}`; `Layout.astro:22-37` auto-renders a banner for every unconfigured entry.
- **No `src/lib/services/` dir, zero outbound HTTP in `src` today, no JSON API route** (auth
  routes redirect). This change introduces the first of each — set the reference pattern.

### Key Discoveries:

- **The blocker is authentication, not data fetch.** Only `sso.garmin.com` is TLS-fingerprint
  blocked; `connectapi.garmin.com` data endpoints accept a plain OAuth2 bearer token. So the
  sidecar must own login + refresh; data calls are cheap once it holds the token
  (`garmin-library-research.md`).
- **`garmin-connect-client` covers activities + sleep, but NOT Body Battery, standalone HRV, or
  scheduled workouts, and exposes no raw-request escape hatch** (`garmin-connect-client-api.md`).
  The sidecar fills these gaps with raw `connectapi.garmin.com` calls (paths verified in research):
  - Body Battery: `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate=&endDate=`
  - Daily summary (BB current/charged/drained): `GET /usersummary-service/usersummary/daily/{displayName}?calendarDate=YYYY-MM-DD`
  - Calendar (today's scheduled workout): `GET /calendar-service/year/{year}/month/{month}` — **month is 0-indexed** — filter to today client-side
  - Scheduled workout detail: `GET /workout-service/schedule/{scheduledWorkoutId}`
- **There is NO clean endpoint for "today's Garmin Coach suggested workout"** (cyberjunky issue
  #305, still open). Only manually-scheduled calendar workouts are reliably fetchable — this is
  why the no-plan UX (Phase 4) falls back to manual entry.
- **Auth API:** `login({username,password})` returns `LoginSuccess {client}` or `MfaPending
  {mfaRequired:true, cookies}`; resume with `login(pending, mfaCode)`. `client.getSession()` →
  `PersistedSession`; `fromSession(session)` rehydrates with no network call;
  `client.onSessionUpdate(cb)` fires when tokens auto-refresh (re-persist then).

## Desired End State

A logged-in runner can:
1. Open a "Connect Garmin" flow, enter Garmin credentials, complete a one-time MFA challenge, and
   have the connection persisted (session blob + encrypted password) in `garmin_credentials`.
2. See on their dashboard, fetched live via the sidecar: recovery metrics (sleep score, HRV,
   Body Battery), their last 3–4 activities, and today's scheduled workout from the Garmin
   calendar — or, when none is scheduled, a manual-entry field for today's planned workout.
3. On a Garmin/sidecar failure, see a graceful "Garmin unavailable / reconnect" state backed by
   the last good cached snapshot, never a crash or blank screen.

Verify: connect a real Garmin account end-to-end in `wrangler dev` against the deployed Koyeb
sidecar; confirm all three data groups render; kill the sidecar and confirm graceful degradation;
confirm the config banner appears when Garmin env vars are unset.

## What We're NOT Doing

- **No write-back to Garmin** (.fit upload, scheduling) — PRD Non-Goal; S-01 is read-only.
- **No history UI beyond last 3–4 activities** (FR-002b is nice-to-have, deferred).
- **No AI recommendation logic** — that is S-03; S-01 only surfaces data.
- **No headless-browser auth path** — kept as a documented plan-B in the research, not built now.
- **No Strava fallback** — recovery data (BB/HRV) is the wedge; Garmin is primary.
- **No application-level encryption of `session_data`** — RLS + server-only read is the chosen
  bar for the session blob (the Garmin *password* is encrypted; see Phase 1).
- **No parsing of Garmin Coach adaptive-plan internals** to derive "today's suggested workout" —
  no stable endpoint exists; we use the calendar + manual fallback instead.
- **No standalone HRV-status fetch** — HRV for S-01 comes from the sleep payload
  (`hrvAdjustment`); a dedicated HRV-status endpoint is out of scope (unverified, deferred).

## Implementation Approach

Two deployment units. **The Worker (this repo)** gains a schema migration, env/config wiring, a
`garmin` service module, JSON API routes, and UI. **The sidecar (new, on Koyeb)** is a small Node
service that wraps `garmin-connect-client`, owns the Garmin session, and exposes a shared-secret
authed JSON API. The Worker never holds Garmin tokens or talks to Garmin directly — it only calls
our own sidecar contract. Build the Worker foundation (Phase 1) and the sidecar (Phase 2)
independently, then wire them (Phase 3) and surface them in the UI (Phase 4).

## Critical Implementation Details

- **MFA cannot be bypassed by the stored password.** Session reuse (`fromSession` +
  `onSessionUpdate`) is the primary keep-alive. The encrypted password is a re-login *fallback*
  for when the session fully dies; if Garmin re-challenges MFA on that re-login, the flow must
  fall back to interactive re-connect (surface a "reconnect Garmin" state). Design the connect
  flow as resumable, not fire-and-forget.
- **MFA resume vs. scale-to-zero (risk):** the two-step login (login → `mfa_required` →
  submit code) can land the second call on a cold-started/different Koyeb instance. This only
  works if the library's `pending` blob is fully self-contained. Verify in Phase 2 (step 2.8);
  if it isn't, keep the connect flow warm (min-instance=1 during connect) or carry the resume
  state in the Worker.
- **Password encryption boundary:** the Worker encrypts/decrypts the Garmin password with a
  server-only key (new secret); the sidecar receives the *plaintext* password only transiently
  over the HTTPS call when a (re)login is needed, never persists it. The encrypted blob lives in
  `garmin_credentials` under RLS. Use WebCrypto (`crypto.subtle`, AES-GCM) — available in the
  Workers runtime — not a Node-only crypto lib.
- **Calendar month is 0-indexed** in `connectapi` (`/calendar-service/year/{y}/month/{m}`) —
  off-by-one here silently returns the wrong month.
- **Sidecar cold start (1–5 s on Koyeb scale-to-zero)** counts against the PRD's "any op > 2 s
  must show visible progress" NFR — the connect and fetch UI must show progress, not block
  silently.

## Phase 1: Foundation — schema, config, secrets, crypto (Worker side)

### Overview

Extend `garmin_credentials` to store the Garmin session and encrypted password, regenerate types,
declare the new server secrets, register the config banner, and add the password-crypto helper.
No Garmin calls yet — this is purely the local foundation the integration builds on.

### Changes Required:

#### 1. Migration — extend `garmin_credentials`

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_add_garmin_session_storage.sql` (new)

**Intent**: Add columns to store the full Garmin session blob and the encrypted Garmin password,
plus a last-good data snapshot for graceful degradation. Keep existing scalar token columns for
quick expiry checks. RLS already covers the table; new columns inherit it.

**Contract**: `ALTER TABLE garmin_credentials ADD COLUMN session_data JSONB`,
`ADD COLUMN garmin_password_encrypted TEXT`, `ADD COLUMN last_snapshot JSONB`,
`ADD COLUMN last_synced_at TIMESTAMPTZ`. All nullable (a row may exist mid-connect). Follow the
header-comment + per-column style of the existing migration. Do not alter existing RLS policies.

#### 2. Regenerate DB types + domain export

**File**: `src/types/database.ts`, `src/types.ts`

**Intent**: Reflect the new columns in the generated `Database` type so the typed Supabase client
sees them. Add the new fields to the `garmin_credentials` `Row`/`Insert`/`Update` blocks.

**Contract**: `src/types/database.ts:23-53` gains `session_data: Json | null`,
`garmin_password_encrypted: string | null`, `last_snapshot: Json | null`,
`last_synced_at: string | null` across Row/Insert/Update. `GarminCredentials` in `src/types.ts:4`
flows through automatically. Prefer `npx supabase gen types` if available; otherwise hand-edit to
match the existing shape.

#### 3. Declare Garmin env vars

**File**: `astro.config.mjs`

**Intent**: Add the three server-only secrets the integration needs, optional so the app still
degrades gracefully when unset.

**Contract**: In `env.schema` (`astro.config.mjs:17-22`) add `GARMIN_SIDECAR_URL`,
`GARMIN_SIDECAR_SECRET`, `GARMIN_PASSWORD_ENC_KEY`, each
`envField.string({ context: "server", access: "secret", optional: true })`. Add the same keys to
`.env` / `.dev.vars` (placeholders) and document them. Run `npx astro sync` after.

#### 4. Register config-status banner

**File**: `src/lib/config-status.ts`

**Intent**: Surface a banner (like Supabase's) when Garmin sidecar vars are missing, so a
half-configured deploy is visible rather than silently broken.

**Contract**: Append a `ConfigStatus` entry `{ name: "Garmin", configured: Boolean(GARMIN_SIDECAR_URL
&& GARMIN_SIDECAR_SECRET && GARMIN_PASSWORD_ENC_KEY), message, docsUrl }` to `configStatuses`
(`:11-21`). `Layout.astro` renders it automatically — no Layout change needed.

#### 5. Password crypto helper

**File**: `src/lib/services/garmin-crypto.ts` (new; first file in `src/lib/services/`)

**Intent**: Encrypt/decrypt the Garmin password with the server key, server-side only, using the
Workers-native WebCrypto API.

**Contract**: Export `encryptPassword(plaintext: string): Promise<string>` and
`decryptPassword(blob: string): Promise<string>` using AES-GCM via `crypto.subtle`, key derived
from `GARMIN_PASSWORD_ENC_KEY`. Output is a self-describing string (iv + ciphertext, base64).
Snippet-worthy because the IV-prefixing + base64 contract is what Phase 3 depends on:

```
// stored form: base64(iv) + "." + base64(ciphertext); decrypt splits on "."
```

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against a local Supabase: `npx supabase db reset` (or `db push`)
- `npx astro sync` succeeds with the new env vars
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- With Garmin env vars unset, the dashboard shows the Garmin config banner (like Supabase's)
- `garmin_credentials` shows the new columns in the local Supabase Studio
- A round-trip `encryptPassword` → `decryptPassword` returns the original string (scratch test)

**Implementation Note**: After automated verification passes, pause for manual confirmation
before Phase 2.

---

## Phase 2: Garmin sidecar service (Koyeb)

### Overview

Build the small Node service that owns all Garmin I/O: programmatic login + MFA resume + session
reuse via `garmin-connect-client`, plus raw `connectapi` calls for the gaps (Body Battery,
calendar). Expose a clean, shared-secret-authed JSON API. Deploy to Koyeb (Free, Frankfurt,
scale-to-zero). This unit lives outside the Astro repo (separate folder/repo — it cannot share
the Workers runtime).

### Changes Required:

#### 1. Sidecar project scaffold

**File**: `sidecar/` (new directory or separate repo) — `package.json`, `tsconfig.json`,
`Dockerfile`, `src/server.ts`

**Intent**: A minimal Node HTTP service (Express/Fastify or Node `http`) on `node >=20` depending
on `garmin-connect-client`. Dockerized so Koyeb can build it (the native `node-libcurl-ja3`
addon needs a real Linux container, not edge).

**Contract**: `package.json` deps include `garmin-connect-client` + a minimal HTTP framework;
`engines.node >=20`. `Dockerfile` builds a Linux image with native build deps for
`node-libcurl-ja3`. A `PORT` env + `GARMIN_SIDECAR_SECRET` env for inbound auth.

#### 2. Shared-secret auth middleware

**File**: `sidecar/src/auth.ts` (new)

**Intent**: Reject any request without the agreed bearer secret so only our Worker can call the
sidecar.

**Contract**: Middleware checks `Authorization: Bearer <GARMIN_SIDECAR_SECRET>`; `401` otherwise.
Applied to all routes.

> **Security note (residual risk):** the sidecar is internet-reachable and will log into any
> Garmin account given credentials — guarded only by this bearer. If the secret leaks it becomes
> an open Garmin-login/proxy oracle. Mitigate cheaply: use a long random secret, rotate it via a
> Koyeb secret (not baked into the image), and — if Koyeb supports it — restrict ingress to the
> Worker's egress range. Accept for MVP; revisit if the service is ever scaled up.

#### 3. Connect/login endpoints

**File**: `sidecar/src/routes/auth.ts` (new)

**Intent**: Drive `garmin-connect-client`'s `login()` + MFA-resume, and rehydrate from a stored
session. Return the `PersistedSession` to the caller (the Worker persists it); never store it in
the sidecar (it is stateless / scale-to-zero).

**Contract**:
- `POST /garmin/login` body `{ username, password }` → `{ status: "ok", session }` |
  `{ status: "mfa_required", pending }` (pending = the resume token/cookies the library returns).
- `POST /garmin/login/mfa` body `{ pending, mfaCode }` → `{ status: "ok", session }` |
  `{ status: "mfa_invalid" }`.
- All data routes accept the session in the request (header or body), call
  `fromSession(session)`, and if the library emits `onSessionUpdate`, return the refreshed session
  alongside the data so the Worker re-persists. Map library error classes
  (`InvalidCredentialsError`, `MfaCodeInvalidError`, `NotAuthenticatedError`, …) to stable JSON
  error codes.

#### 4. Data endpoints (typed methods + raw connectapi gaps)

**File**: `sidecar/src/routes/data.ts` (new)

**Intent**: One normalized endpoint per S-01 data group. Use library methods where they exist;
make raw `connectapi.garmin.com` bearer-token calls for Body Battery and the calendar.

**Contract** (all require a valid session; all return normalized JSON + any refreshed session):
- `GET /garmin/activities?limit=4` → from `client.getActivities(0, 4)`.
- `GET /garmin/recovery?date=YYYY-MM-DD` → sleep from `client.sleep.getDailySleepData(date)`
  (+ `hrvAdjustment`); Body Battery from raw
  `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate=date&endDate=date`;
  optionally daily summary for current/charged/drained BB. **HRV for S-01 is the sleep-scoped
  `hrvAdjustment`** — this is the committed HRV source and satisfies FR-002's HRV requirement.
  A standalone HRV-status fetch is explicitly out of scope here (no verified endpoint); revisit
  in a later slice only if S-03's AI prompt needs the dedicated HRV score.
- `GET /garmin/scheduled-workout?date=YYYY-MM-DD` → raw
  `GET /calendar-service/year/{year}/month/{month}` (**month 0-indexed**), filtered to `date`;
  if a scheduled item exists, optionally enrich via `GET /workout-service/schedule/{id}`. Returns
  `{ workout }` or `{ workout: null }` (drives the Phase 4 manual-entry fallback).

#### 5. Koyeb deployment

**File**: `sidecar/README.md` (new), Koyeb service config

**Intent**: Deploy the Docker image to a free Koyeb web service (Frankfurt), scale-to-zero, with
`GARMIN_SIDECAR_SECRET` set as a Koyeb secret. Capture the public URL for the Worker's
`GARMIN_SIDECAR_URL`.

**Contract**: README documents: build/push the image, create the Koyeb Free instance (region
Frankfurt), set `PORT` + `GARMIN_SIDECAR_SECRET`, obtain the `*.koyeb.app` URL. Note the
scale-to-zero cold-start behavior for the Worker timeout/UX.

### Success Criteria:

#### Automated Verification:

- Sidecar builds: `docker build` succeeds (native `node-libcurl-ja3` compiles)
- Sidecar starts locally and `401`s an unauthenticated request; `200`s a health check with the secret
- Sidecar TypeScript compiles / lints

#### Manual Verification:

- Against a real Garmin account: `POST /garmin/login` returns a session (or `mfa_required`, then resume succeeds)
- **MFA resume survives a sidecar restart**: kill/restart the sidecar instance between `POST /garmin/login` and `POST /garmin/login/mfa`, then confirm resume still succeeds — proves the `pending` blob is self-contained and MFA won't break on Koyeb scale-to-zero
- **Unattended re-login check (gates Phase 3)**: from a fully-expired session, confirm whether re-login using the stored password alone (no MFA prompt) actually succeeds for this account. Records whether the encrypted-password path is usable or must stay dormant
- `/garmin/recovery`, `/garmin/activities`, `/garmin/scheduled-workout` return plausible normalized data (recovery includes sleep score, sleep-scoped HRV, and Body Battery)
- Deployed Koyeb service is reachable over HTTPS with the bearer secret; cold start is 1–5 s
- A second call reuses the persisted session without re-login

**Implementation Note**: After automated verification passes, pause for manual confirmation
(this is the riskiest phase — it proves the integration hypothesis) before Phase 3.

---

## Phase 3: Worker ↔ sidecar integration (service + API routes)

### Overview

Wire the Worker to the sidecar: a `garmin` service that calls the sidecar over HTTPS, persists
and rehydrates the session + encrypted password in `garmin_credentials`, implements the re-login
fallback, and caches the last good snapshot; plus the JSON API routes the UI calls.

### Changes Required:

#### 1. Garmin service module

**File**: `src/lib/services/garmin.ts` (new — first outbound-HTTP module; reference pattern)

**Intent**: A typed client to the sidecar (HTTPS `fetch` + `Authorization: Bearer
GARMIN_SIDECAR_SECRET`), plus the orchestration: load session from `garmin_credentials`, call the
sidecar, re-persist refreshed sessions, and on `NotAuthenticated` attempt a re-login using the
decrypted stored password (falling back to "reconnect required" if MFA is re-challenged). On any
sidecar/Garmin failure, return the cached `last_snapshot` with a `stale: true` flag.

**Contract**: Exports e.g. `connectGarmin(supabase, userId, {username, password})`,
`submitMfa(...)`, `getRecovery(supabase, userId)`, `getActivities(...)`,
`getScheduledWorkout(...)`. Each accepts the per-user Supabase client (so reads/writes are RLS
scoped). Defines normalized DTO types (see #3). Persists `session_data`, `garmin_password_encrypted`
(via `garmin-crypto`), `last_snapshot`, `last_synced_at`. All sidecar calls go through one
internal `callSidecar(path, init)` helper that injects the bearer and a timeout.

> **Gated on Phase 2 step 2.9:** build the automatic decrypt-and-re-login orchestration only if
> unattended re-login was shown to work. If Garmin re-challenges MFA on re-login, keep the
> encrypted password dormant (last-resort) and have the service surface a "reconnect Garmin"
> state instead of attempting silent re-login — the connect + session-reuse path stands alone.

#### 2. Garmin JSON API routes

**File**: `src/pages/api/garmin/connect.ts`, `src/pages/api/garmin/mfa.ts`,
`src/pages/api/garmin/data.ts` (new)

**Intent**: First JSON API routes in the codebase. Follow the auth-route template
(`src/pages/api/auth/signin.ts`) for `createClient` + null-check, but return `new Response(JSON…)`
per CLAUDE.md (Zod-validated input) instead of redirecting. Each route must check
`context.locals.user` itself (these paths are not in `PROTECTED_ROUTES`).

**Contract**:
- `POST /api/garmin/connect` — Zod `{username, password}`; calls `connectGarmin`; returns
  `{ status: "ok" | "mfa_required" }`.
- `POST /api/garmin/mfa` — Zod `{mfaCode}`; calls `submitMfa`; returns `{ status }`.
- `GET /api/garmin/data` — returns `{ recovery, activities, scheduledWorkout, stale }` for the
  dashboard. `401` when `!locals.user`; `503`-style graceful payload when the sidecar is down.

#### 3. Shared Garmin DTO types

**File**: `src/types.ts` (extend)

**Intent**: Define the normalized shapes the sidecar returns and the UI consumes (recovery,
activity, scheduled workout), so the service and UI share one contract.

**Contract**: Add `GarminRecovery`, `GarminActivity`, `GarminScheduledWorkout`, `GarminDashboardData`
(with `stale: boolean`) interfaces. These mirror the sidecar's normalized JSON, not Garmin's raw
payloads.

#### 4. Mock-sidecar contract tests

**File**: `src/lib/services/garmin.test.ts` (new), `package.json` (add `test` script),
`vitest.config.ts` (new), `.github/workflows/ci.yml` (add test step)

**Intent**: Establish the testing baseline with **Vitest** (native to the Vite/Astro stack —
first test runner in the repo): unit-test the service against a mocked sidecar (stubbed `fetch`)
for the happy path, MFA-required path, re-login fallback, and stale-cache fallback. CI never
touches Garmin.

**Contract**: Add `vitest` as a dev dependency and a `"test": "vitest run"` script to
`package.json`. Mock `fetch`/`callSidecar`; assert session persistence, MFA branching, decryption
on re-login, and that a sidecar failure returns the cached snapshot with `stale: true`. Add a
`test` step to `.github/workflows/ci.yml` after `build`, running **without** any Garmin secret
present (the existing flow is `astro sync → lint → build`).

### Success Criteria:

#### Automated Verification:

- Service unit tests pass against the mocked sidecar: `npm test`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- CI runs `astro sync → lint → build → test` with no Garmin secret present

#### Manual Verification:

- In `wrangler dev` with sidecar configured: `POST /api/garmin/connect` persists a session
  (and `garmin_password_encrypted`) in `garmin_credentials`
- `GET /api/garmin/data` returns live recovery/activities/scheduled-workout JSON
- Stopping the sidecar makes `GET /api/garmin/data` return the cached snapshot with `stale:true`

**Implementation Note**: After automated verification passes, pause for manual confirmation
before Phase 4.

---

## Phase 4: UI — connect flow, dashboard display, fallbacks

### Overview

Surface the integration: a "Connect Garmin" flow (credentials + MFA step), and a dashboard
section rendering today's workout (calendar or manual-entry fallback), recent activities, and
recovery metrics — with progress feedback and graceful degradation states.

### Changes Required:

#### 1. Connect Garmin flow

**File**: `src/components/garmin/ConnectGarmin.tsx` (new React island) + a page/section entry

**Intent**: Two-step interactive connect: credentials form → (if `mfa_required`) MFA-code form →
success. Shows visible progress (sidecar cold start can take seconds). Posts to
`/api/garmin/connect` and `/api/garmin/mfa`.

**Contract**: Hydrated island (`client:load`). Uses `cn()` for classes, shadcn/ui inputs/buttons.
Surfaces the `mfa_required` / `mfa_invalid` / `invalid_credentials` states from the API. On
success, refreshes the dashboard data. Hooks extracted to `src/components/hooks/` if non-trivial.

#### 2. Dashboard data section

**File**: `src/pages/dashboard.astro` (extend) + `src/components/garmin/GarminDashboard.tsx` (new)

**Intent**: Render the three S-01 data groups. SSR-fetch via the service (or fetch
`/api/garmin/data` from an island with a loading state). Today's-workout block shows the calendar
workout when present, else a manual-entry field (PRD Open Question 1 resolution).

**Contract**: `dashboard.astro:1-27` gains a Garmin section below the welcome card. Shows: not-
connected state → renders `ConnectGarmin`; connected → recovery metrics (sleep score, HRV, Body
Battery), last 3–4 activities, today's workout (calendar | manual entry). `stale: true` renders a
"data may be out of date" notice; sidecar-down renders a "Garmin unavailable — reconnect" state.
No raw numbers without labels; plain-language, consistent with existing styling.

#### 3. Manual workout entry fallback

**File**: `src/components/garmin/ManualWorkoutEntry.tsx` (new) — or inline in `GarminDashboard`

**Intent**: When no scheduled workout is fetchable, let the runner type today's planned workout so
the product loop (modify-a-planned-workout) still works downstream (S-03).

**Contract**: Simple controlled input (workout description / type / duration). For S-01 it feeds
the display only; persistence of the manual plan can be a thin local/state concern (full
persistence is an S-03 concern). Keep the contract minimal and labeled clearly as the no-plan path.

### Success Criteria:

#### Automated Verification:

- Build succeeds with the new islands: `npm run build`
- Linting passes: `npm run lint`
- Type checking passes: `npx astro check`

#### Manual Verification:

- End-to-end in `wrangler dev`: connect a real Garmin account (incl. MFA) → dashboard shows
  recovery + activities + today's workout
- Account/day with no scheduled workout shows the manual-entry field, not a blank/broken state
- Sidecar down → "Garmin unavailable / reconnect" state with last-good data, no crash
- Operations > 2 s show visible progress (NFR); connect cold start shows a spinner/skeleton
- No regression to existing auth/dashboard for a user who hasn't connected Garmin

**Implementation Note**: After automated verification passes, pause for final manual confirmation.
This closes S-01.

---

## Testing Strategy

### Unit Tests (mocked sidecar — CI-safe):

- Service happy path: session persisted, normalized data returned.
- MFA branching: `mfa_required` then successful resume.
- Re-login fallback: expired session → decrypt stored password → re-login; MFA re-challenge →
  "reconnect required".
- Graceful degradation: sidecar failure → cached `last_snapshot` with `stale: true`.
- Password crypto round-trip (`encryptPassword`/`decryptPassword`).

### Integration / Manual Tests (live Garmin — run by hand, never in CI):

- Full connect (incl. MFA) against a real account in `wrangler dev` → deployed Koyeb sidecar.
- Each data endpoint returns plausible values; session is reused on the second call.
- No-plan day shows manual entry; sidecar-down shows degradation.

### Manual Testing Steps:

1. Deploy sidecar to Koyeb; set `GARMIN_*` vars in `.dev.vars`; `npm run dev`.
2. Sign in, open dashboard, run "Connect Garmin", complete MFA.
3. Verify recovery / activities / today's workout render.
4. Pick a day with no scheduled workout → confirm manual entry appears.
5. Stop the Koyeb service → confirm graceful "unavailable" + stale cache.

## Performance Considerations

- Sidecar **cold start (1–5 s)** plus Garmin latency must stay within the PRD's 10 s p95 (this
  budget is hard-binding in S-03; S-01 must not architect it away). Show progress for any op > 2 s.
- Cache the last good snapshot (`last_snapshot`) to avoid hammering Garmin and to serve instantly
  on transient failures.
- Keep the sidecar single-purpose (no Chromium) so the Koyeb Free 0.1 vCPU / 512 MB suffices.

## Migration Notes

- One additive migration (`session_data`, `garmin_password_encrypted`, `last_snapshot`,
  `last_synced_at`), all nullable — no backfill, no data loss. Existing scalar token columns are
  retained. Regenerate `src/types/database.ts` after applying.

## References

- Research: `context/changes/garmin-connect-and-fetch/research.md` (codebase compatibility)
- `context/changes/garmin-connect-and-fetch/garmin-library-research.md` (TLS block, sidecar verdict)
- `context/changes/garmin-connect-and-fetch/garmin-connect-client-api.md` (API surface + gap endpoints)
- `context/changes/garmin-connect-and-fetch/garmin-connect-mcp-eval.md` (plan-B browser auth)
- Schema: `supabase/migrations/20260604000001_create_domain_tables.sql:40-60`
- Client/env pattern: `src/lib/supabase.ts:3,6,10`; `astro.config.mjs:17-22`
- Route template: `src/pages/api/auth/signin.ts`; config banner: `src/lib/config-status.ts:11-21`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Foundation — schema, config, secrets, crypto

#### Automated

- [x] 1.1 Migration applies cleanly against a local Supabase (`db reset`/`db push`) — 23f8532
- [x] 1.2 `npx astro sync` succeeds with the new env vars — 23f8532
- [x] 1.3 Type checking passes (`npx astro check`) — 23f8532
- [x] 1.4 Linting passes (`npm run lint`) — 23f8532
- [x] 1.5 Production build succeeds (`npm run build`) — 23f8532

#### Manual

- [x] 1.6 Garmin config banner shows when env vars unset — 23f8532
- [x] 1.7 New columns visible in local Supabase Studio — 23f8532
- [x] 1.8 `encryptPassword`→`decryptPassword` round-trip returns original — 23036cd (Vitest test)

### Phase 2: Garmin sidecar service (Koyeb)

#### Automated

- [x] 2.1 Sidecar builds (`docker build`, native addon compiles)
- [x] 2.2 Sidecar `401`s unauthenticated; `200`s health check with secret
- [x] 2.3 Sidecar TypeScript compiles / lints — 85ec381

#### Manual

- [x] 2.4 `POST /garmin/login` returns session (or mfa_required + successful resume) on a real account
- [x] 2.5 recovery / activities / scheduled-workout return plausible normalized data
- [x] 2.6 Deployed Cloud Run service reachable over HTTPS with bearer; cold start 1–5 s (scale-to-zero)
- [x] 2.7 Second call reuses persisted session without re-login
- [ ] 2.8 MFA resume survives a sidecar restart between the two login calls
- [x] 2.9 Unattended re-login from stored password alone verified (usable — account has no MFA; login returns ok directly)

### Phase 3: Worker ↔ sidecar integration

#### Automated

- [x] 3.1 Service unit tests pass against mocked sidecar (`npm test`) — 3ba17f9
- [x] 3.2 Type checking passes (`npx astro check`) — 3ba17f9
- [x] 3.3 Linting passes (`npm run lint`) — 3ba17f9
- [x] 3.4 Build succeeds (`npm run build`) — 3ba17f9
- [x] 3.5 CI runs astro sync → lint → build → test with no Garmin secret — 3ba17f9

#### Manual

- [x] 3.6 `POST /api/garmin/connect` persists session + encrypted password in `garmin_credentials` — 23036cd
- [x] 3.7 `GET /api/garmin/data` returns live data — 23036cd
- [x] 3.8 Sidecar stopped → `GET /api/garmin/data` returns cached snapshot with `stale:true` — 23036cd

### Phase 4: UI — connect flow, dashboard display, fallbacks

#### Automated

- [x] 4.1 Build succeeds with new islands (`npm run build`) — e8efe26
- [x] 4.2 Linting passes (`npm run lint`) — e8efe26
- [x] 4.3 Type checking passes (`npx astro check`) — e8efe26

#### Manual

- [x] 4.4 End-to-end connect (incl. MFA) → dashboard shows recovery + activities + today's workout — 23036cd (no-MFA account)
- [x] 4.5 No scheduled workout → manual-entry field appears — 23036cd
- [x] 4.6 Sidecar down → "Garmin unavailable / reconnect" with last-good data, no crash — 23036cd
- [x] 4.7 Operations > 2 s show visible progress (cold-start spinner/skeleton) — 23036cd
- [x] 4.8 No regression for a user who hasn't connected Garmin — 23036cd
