# Garmin Credential Control & Privacy — Implementation Plan

## Overview

Add two runner-facing capabilities to the Garmin connect surface (roadmap slice **S-07**):

1. **Disconnect** — one action that deletes everything GainPace stores for a runner's Garmin connection (session blob, encrypted password, cached snapshot), returning them to the not-connected state.
2. **"Don't store my Garmin credentials" opt-out** — at connect time, a checkbox that keeps the Garmin session in encrypted, chunked, session-scoped browser cookies instead of the database. Nothing is written server-side; the runner re-authenticates each new browser session. Silent re-login is unavailable in this mode by design (no stored password to recover from).

The enabling refactor is a **`SessionStore` seam** in `src/lib/services/garmin.ts`: session persistence is routed to either a DB-backed store (default, current behavior) or a cookie-backed store (ephemeral), selected per request.

## Current State Analysis

- **Session sourcing is DB-only.** `loadRow` (`garmin.ts:130`), `persistSession` (`:136`), and `getDashboardData` (`:301`) read/write `garmin_credentials.session_data` directly. `reLogin` (`:244`) recovers a dead session from the stored `garmin_password_encrypted` + `garmin_user_id`.
- **MFA pending blob** (`{ mfaRequired, cookies }`) is stashed in `session_data` (`garmin.ts:188-199`); `submitMfa` reads it back (`:219`).
- **No disconnect path exists.** `GarminDashboard` (`src/components/garmin/GarminDashboard.tsx`) has no control to sever the connection.
- **Cookies are touched in exactly one place** — `src/lib/supabase.ts` via `@supabase/ssr`'s `getAll`/`setAll`, with library-default options. There is no existing direct `context.cookies.set`/`.delete` usage to copy, but `AstroCookies` exposes `.get()/.set(name,value,opts)/.delete(name,opts)` with `{ httpOnly, secure, sameSite, path, maxAge, expires }`.
- **Crypto template exists.** `src/lib/services/garmin-crypto.ts` implements Workers-native AES-GCM (`crypto.subtle`, SHA-256-derived key from `GARMIN_PASSWORD_ENC_KEY`, `base64(iv).base64(ct)` form). Currently exposes `encryptPassword`/`decryptPassword` — string-only.

### Key Discoveries:

- **The session blob will not fit in one cookie.** It is `{ cookies, oauth2Token, diClientId }` — raw JSON ~4–6 KB (dominated by the tough-cookie jar, ~8–15 cookies; the OAuth2 access-token JWT ~1.3 KB is second), ~5.6–8.3 KB after AES-GCM + base64. Cookie-only mode **must chunk across 2–3 cookies**. The cookie jar is the variable driver, not the JWT.
- **No OAuth1 token** is stored — the persisted session has only `cookies + oauth2Token + diClientId`. The comment at `supabase/migrations/20260615000001_add_garmin_session_storage.sql:13` ("OAuth1 + OAuth2 + cookies") is stale.
- **No migration is needed.** Disconnect is a row delete; ephemeral mode writes nothing to the DB.
- **Mutual exclusivity** (decided): each connect clears the other store, so at most one of {DB row, cookie session} exists per user — session detection can therefore be unambiguous.

## Desired End State

- A connected runner sees a **Disconnect** control; using it (after a confirm) deletes their `garmin_credentials` row and any session cookies, and the UI returns to the connect screen. `workout_selections` and `race_goals` are untouched.
- The connect form shows an unchecked **"Don't store my Garmin credentials"** checkbox. When ticked, a successful connect persists the session only to encrypted session cookies; no `garmin_credentials` row is created. Reloading the page keeps the runner connected within the same browser session; a new browser session requires re-authentication.
- Stored (default) mode behaves exactly as today — no regression to silent re-login, MFA, snapshot caching, or graceful degradation.

Verify: connect in each mode, confirm DB state (`select` on `garmin_credentials`) and cookie presence match the mode; disconnect wipes both; ephemeral session survives reload but not a fresh browser session.

## What We're NOT Doing

- No database migration or schema change.
- No caching of the data snapshot in cookie-only mode (strict hygiene — a mid-session failure shows reconnect/error, not stale data).
- No silent (password-based) re-login in cookie-only mode.
- No new automated tests (manual-only verification, per decision) beyond the existing lint/build gates.
- No change to the sidecar (`sidecar/**`) — its contract is unchanged.
- No "remember this choice" persistence — the opt-out is a per-connect checkbox, not a stored preference.

## Implementation Approach

Introduce a `SessionStore` abstraction that normalizes how a Garmin session is loaded, persisted, snapshotted, and cleared. `garmin.ts`'s connect/MFA/fetch functions take a store instead of `(supabase, userId)`. Two implementations:

- **`DbSessionStore`** — wraps the current `garmin_credentials` upsert/select/delete + snapshot logic. Reports `persistsPassword = true`.
- **`CookieSessionStore`** — encrypts + chunks the session into session-scoped cookies; `saveSnapshot` is a no-op; `load` returns no password/username/snapshot. Reports `persistsPassword = false`.

API routes pick the store per request: `/connect` from the `ephemeral` body flag (clearing the other store first); `/mfa` and `/data` by detecting which store holds a session (cookie chunks present → cookie, else DB). Build the disconnect capability first (independently shippable), then the seam + cookie util (regression-isolated), then the ephemeral flow.

## Critical Implementation Details

- **Cookie sizing & chunking.** Cap each chunk's value at ~3500 chars to stay under the ~4 KB per-cookie ceiling once the name and attributes are added. Store the chunk count so `clear()` and `load()` know the range (e.g. a `gc_sess_n` count cookie alongside `gc_sess_0..N-1`). `load()` must return `null` (not a partial session) if the count cookie or any chunk is missing.
- **Cookie attributes.** `httpOnly: true`, `secure: true`, `sameSite: "lax"`, `path: "/"`, and **no** `maxAge`/`expires` (session cookie — cleared on browser close). These must be applied identically on every chunk and on the count cookie.
- **At-most-once re-login ordering** in `getDashboardData` (`garmin.ts:312-322`) must be preserved: the recovery fetch may refresh the session, and the reload-before-parallel-fetch step must re-read from the *same store*, not always the DB.
- **Mutual-exclusivity clearing happens before the sidecar call** in `/connect`, so a failed connect doesn't leave both stores populated.

## Phase 1: Disconnect

### Overview

Deliver the disconnect capability end-to-end: a service function, a JSON API route, and a confirm-gated UI control. Clears both the DB row and any session cookies so it is correct once ephemeral mode ships.

### Changes Required:

#### 1. Disconnect service function

**File**: `src/lib/services/garmin.ts`

**Intent**: Add a `disconnectGarmin` that removes all stored Garmin state for a user across both possible stores (DB row + session cookies), so a disconnect is complete regardless of which mode the runner used.

**Contract**: `export async function disconnectGarmin(supabase: TypedSupabase, userId: string, cookies: AstroCookies): Promise<void>`. Deletes the `garmin_credentials` row for `userId` and clears the session cookies (delegates cookie clearing to the util added in Phase 2 — for Phase 1, a local "delete `gc_sess*` cookies" helper is acceptable and is superseded in Phase 2). Surfaces a DB delete error as `GarminError`, mirroring `persistSession`.

#### 2. Disconnect API route

**File**: `src/pages/api/garmin/disconnect.ts` (new)

**Intent**: Expose disconnect as an authenticated JSON endpoint following the existing garmin-route template (`connect.ts` — auth guard, `createClient` null-check, JSON helper, error taxonomy).

**Contract**: `POST /api/garmin/disconnect` → `{ status: "ok" }` on success; `401 unauthorized`, `503 not_configured`, `502 garmin_error` per the existing pattern. Passes `context.cookies` into `disconnectGarmin`.

#### 3. Disconnect UI control

**File**: `src/components/garmin/GarminDashboard.tsx`

**Intent**: Add a low-emphasis Disconnect control that requires an explicit confirm before calling the endpoint, then triggers the existing reload path so the section falls back to `ConnectGarmin`.

**Contract**: A small confirm interaction (inline "Are you sure? / Disconnect / Cancel", or a shadcn dialog) → on confirm, `fetch("/api/garmin/disconnect", { method: "POST" })` → on `ok`, call a new `onDisconnected` prop (wired in `GarminSection` to the same `reload()` used by reconnect). Uses the existing amber/`TriangleAlert` + `Button` styling vocabulary.

**File**: `src/components/garmin/GarminSection.tsx`

**Intent**: Pass a handler into `GarminDashboard` that clears local state and refetches (the connect/`reconnect` path already does this via `reload()`).

**Contract**: `<GarminDashboard data={data} onReconnect={reload} onDisconnected={reload} />`.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Production build passes (includes type-check): `npx astro sync && npm run build`

#### Manual Verification:

- A connected account shows a Disconnect control; clicking it asks for confirmation.
- Confirming disconnect returns the UI to the connect screen and removes the `garmin_credentials` row (verify via a Supabase `select`).
- Cancelling the confirm leaves the connection intact.
- `race_goals` and `workout_selections` rows for the user are unchanged after disconnect.

**Implementation Note**: After this phase and passing automated verification, pause for manual confirmation before Phase 2.

---

## Phase 2: Session-store seam + cookie utility

### Overview

Refactor `garmin.ts` to persist/load sessions through a `SessionStore` abstraction, with `DbSessionStore` preserving today's behavior exactly. Build the Workers-native cookie session utility (encrypt → chunk → set/read/clear) and `CookieSessionStore`. No user-visible behavior changes in this phase — it is verified by confirming stored mode is unregressed.

### Changes Required:

#### 1. Generalize the crypto helper

**File**: `src/lib/services/garmin-crypto.ts`

**Intent**: Expose generic string encrypt/decrypt so both the password path and the new cookie path share one AES-GCM implementation.

**Contract**: Add `export async function encryptString(plaintext: string): Promise<string>` and `decryptString(blob: string): Promise<string>` (the current `encryptPassword`/`decryptPassword` bodies). Keep `encryptPassword`/`decryptPassword` as thin delegates so existing callers are untouched.

#### 2. Session-store abstraction

**File**: `src/lib/services/garmin-session-store.ts` (new)

**Intent**: Define the normalized session state and the store interface both implementations satisfy, plus the DB implementation wrapping current `garmin_credentials` logic.

**Contract**:
```ts
interface GarminSessionState {
  session: PersistedSession | MfaPending | null;
  encryptedPassword: string | null; // DB only; null in cookie mode
  username: string | null;           // DB only
  snapshot: GarminDashboardData | null; // DB only
}
interface SessionStore {
  readonly persistsPassword: boolean;
  load(): Promise<GarminSessionState | null>;
  persistSession(session: PersistedSession, extra?: { username?: string; encryptedPassword?: string }): Promise<void>;
  persistPending(pending: MfaPending, username: string, encryptedPassword?: string): Promise<void>;
  saveSnapshot(data: GarminDashboardData): Promise<void>;
  clear(): Promise<void>;
}
class DbSessionStore implements SessionStore { constructor(supabase: TypedSupabase, userId: string) }
```
`DbSessionStore` maps `CredRow` → `GarminSessionState` on `load`, and its `persistSession`/`persistPending`/`saveSnapshot`/`clear` reproduce the current upsert / placeholder-upsert / snapshot-update / row-delete exactly (`persistsPassword = true`).

#### 3. Cookie session utility

**File**: `src/lib/services/garmin-session-cookie.ts` (new)

**Intent**: Read/write/clear an encrypted, chunked, session-scoped cookie representation of a session object, and expose it as a `CookieSessionStore`.

**Contract**: Functions `writeSessionCookies(cookies: AstroCookies, value: object)`, `readSessionCookies(cookies: AstroCookies, requestHeaders: Headers): Promise<object | null>`, `clearSessionCookies(cookies: AstroCookies)`. Chunk cookies named `gc_sess_0..N-1` plus a `gc_sess_n` count cookie; per-chunk value ≤ ~3500 chars; attributes `httpOnly/secure/sameSite:"lax"/path:"/"`, no maxAge. `read` returns `null` if the count or any chunk is missing (never a partial). `CookieSessionStore implements SessionStore` with `persistsPassword = false`: `persistSession`/`persistPending` serialize+encrypt+chunk the object; `load` reassembles/decrypts and returns `{ session, encryptedPassword: null, username: null, snapshot: null }`; `saveSnapshot` is a no-op; `clear` deletes all chunk cookies.

> Note: reading a just-set cookie within the same request isn't reliable via the request header, so `read` should prefer `cookies.get()` where available and fall back to the parsed `Cookie` header — mirror how `supabase.ts` reads from the header.

#### 4. Route `garmin.ts` through the store

**File**: `src/lib/services/garmin.ts`

**Intent**: Replace direct `(supabase, userId)` DB access in the connect/MFA/fetch functions with the `SessionStore`, preserving all current control flow (silent re-login, at-most-once reload, snapshot-on-success, graceful degradation).

**Contract**: `connectGarmin(store, creds)`, `submitMfa(store, mfaCode)`, `getDashboardData(store, date?)`, and internal `reLogin(store, state)` / `fetchData(store, state, path)` take a store. `connectGarmin` computes `encryptedPassword` only when `store.persistsPassword`. `reLogin` throws `ReconnectRequiredError` when `state.encryptedPassword`/`username` is null (already the no-password behavior — cookie mode hits this by construction). `getDashboardData` reads the snapshot from `state.snapshot` (null in cookie mode → the no-cache branch), and re-reads via `store.load()` (not the DB) after the recovery fetch.

#### 5. Update existing routes to construct a DB store

**File**: `src/pages/api/garmin/{connect,mfa,data}.ts`

**Intent**: Keep current behavior by passing a `DbSessionStore` (Phase 3 adds the ephemeral branch).

**Contract**: e.g. `getDashboardData(new DbSessionStore(supabase, user.id), date)`. No response-shape change.

#### 6. Fix stale migration comment

**File**: `supabase/migrations/20260615000001_add_garmin_session_storage.sql`

**Intent**: Correct the inaccurate `session_data` comment.

**Contract**: Change the `-- PersistedSession (OAuth1 + OAuth2 + cookies)` comment to reflect the real shape (`oauth2Token + cookies + diClientId`, no OAuth1). Comment-only; the migration is already applied and is not re-run.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Production build passes (includes type-check): `npx astro sync && npm run build`

#### Manual Verification:

- Stored-mode connect, MFA challenge, data fetch, silent re-login after session expiry, stale-snapshot fallback, and reconnect prompt all behave exactly as before this phase (no regression).
- Disconnect (Phase 1) still works and now clears cookies via the shared util.

**Implementation Note**: After this phase and passing automated verification, pause for manual confirmation before Phase 3.

---

## Phase 3: Ephemeral connect flow

### Overview

Wire the `ephemeral` opt-out end-to-end: the checkbox, the flag through `/connect` and `/mfa`, store selection with mutual-exclusivity clearing, MFA-pending in the cookie, and the no-snapshot failure behavior.

### Changes Required:

#### 1. Store selection + mutual exclusivity in `/connect`

**File**: `src/pages/api/garmin/connect.ts`

**Intent**: Accept an `ephemeral` flag; select the cookie or DB store; clear the *other* store before connecting so exactly one persists.

**Contract**: Extend the Zod body with `ephemeral: z.boolean().optional().default(false)`. If `ephemeral`, `store = new CookieSessionStore(context.cookies, request.headers)` and delete any DB row first; else `store = new DbSessionStore(...)` and clear any session cookies first. Call `connectGarmin(store, creds)`. Response shape unchanged.

#### 2. Mode detection in `/mfa` and `/data`

**File**: `src/pages/api/garmin/{mfa,data}.ts`

**Intent**: Pick the store by detecting which one holds a session, since connect made them mutually exclusive.

**Contract**: If `readSessionCookies(...)` returns non-null → `CookieSessionStore`, else `DbSessionStore`. Then `submitMfa(store, code)` / `getDashboardData(store, date)` as in Phase 2.

#### 3. MFA-pending in cookie mode

**File**: `src/lib/services/garmin.ts` (verify) + `CookieSessionStore`

**Intent**: Ensure the `mfa_required` branch persists the pending blob via the store so a cookie-mode MFA resume works.

**Contract**: `connectGarmin`'s `mfa_required` path calls `store.persistPending(pending, username, encryptedPassword?)`; `CookieSessionStore.persistPending` chunks the pending object (smaller — typically one cookie), and `submitMfa` reads it back via `store.load()`. No password stored in cookie mode.

#### 4. Ephemeral failure behavior

**File**: `src/lib/services/garmin.ts` (verify only)

**Intent**: Confirm the strict-hygiene failure path: with `snapshot: null` (cookie mode), a sidecar/Garmin failure yields the no-cache result (`stale: true`, empty payload, `reconnectRequired` when unrecoverable) rather than stale data.

**Contract**: No new code if Phase 2's `state.snapshot` wiring is correct — this is a verification step. `GarminDashboard`'s existing reconnect/stale banners cover the UI.

#### 5. Checkbox UI

**File**: `src/components/garmin/ConnectGarmin.tsx`

**Intent**: Add an unchecked "Don't store my Garmin credentials" checkbox (credentials step only, not the MFA step) with a one-line explanation of the tradeoff, and include its value in the `/connect` body.

**Contract**: New `useState` boolean; a checkbox + helper text ("We'll keep your Garmin session only for this browser session and won't save your login — you'll sign in again next time."); `body: JSON.stringify({ username, password, ephemeral })`. Do not surface it on the `reconnect` variant unless trivial (out of scope otherwise).

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Production build passes (includes type-check): `npx astro sync && npm run build`

#### Manual Verification:

- Connecting with the box **unchecked** creates a `garmin_credentials` row and sets no `gc_sess*` cookies (default mode unchanged).
- Connecting with the box **checked** sets `gc_sess*` cookies (httpOnly, no expiry — visible in devtools as session cookies), creates **no** `garmin_credentials` row, and the dashboard shows live data.
- In ephemeral mode, reloading the page keeps the runner connected; closing the browser (or clearing session cookies) returns them to the connect screen.
- An MFA-protected account can complete the challenge in ephemeral mode.
- Switching modes clears the other store (ephemeral-then-stored leaves only a DB row; stored-then-ephemeral leaves only cookies).
- Simulating a sidecar failure in ephemeral mode shows the reconnect/unavailable state with no stale data.

**Implementation Note**: After this phase and passing automated verification, pause for manual confirmation. This completes S-07.

---

## Testing Strategy

Per the manual-only decision, no new automated tests are added; the existing `garmin.test.ts` continues to run under the build/lint gates. Verification is the per-phase Manual Verification checklists above, exercised against the live sidecar. See Open Risks for the one spot (chunk roundtrip) worth a fast-follow unit test if it misbehaves.

### Manual Testing Steps:

1. Stored-mode regression: connect (with MFA if available), fetch data, force session expiry to trigger silent re-login, confirm stale-snapshot fallback.
2. Disconnect: confirm, then verify DB row gone and UI back to connect.
3. Ephemeral connect: verify cookies set / no DB row / live data / survives reload / gone on new session.
4. Mode switching both directions; verify mutual exclusivity.
5. Ephemeral failure: verify reconnect/no-stale behavior.

## Performance Considerations

Negligible. Cookie encrypt/decrypt is a small AES-GCM op per request in ephemeral mode; chunk count is 2–3. Every ephemeral request re-parses cookies (already done for auth). No added round-trips.

## Migration Notes

None — no schema change. Existing stored-mode users are unaffected (they keep using `DbSessionStore`).

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-07)
- Change identity/notes: `context/changes/garmin-credential-control/change.md`
- Session service: `src/lib/services/garmin.ts`
- Crypto template: `src/lib/services/garmin-crypto.ts`
- Cookie handling precedent: `src/lib/supabase.ts:12-22`
- Session shape: `sidecar/node_modules/garmin-connect-client/dist/types.d.ts` (`PersistedSession`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Disconnect

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — 02b371c
- [x] 1.2 Production build passes: `npx astro sync && npm run build` — 02b371c

#### Manual

- [ ] 1.3 Connected account shows Disconnect control with confirmation
- [ ] 1.4 Confirming returns to connect screen and removes the `garmin_credentials` row
- [ ] 1.5 Cancelling leaves the connection intact
- [ ] 1.6 `race_goals` / `workout_selections` unchanged after disconnect

### Phase 2: Session-store seam + cookie utility

#### Automated

- [x] 2.1 Linting passes: `npm run lint` — 71fae14
- [x] 2.2 Production build passes: `npx astro sync && npm run build` — 71fae14

#### Manual

- [ ] 2.3 Stored-mode connect / MFA / fetch / silent re-login / stale fallback / reconnect all unregressed
- [ ] 2.4 Disconnect still works and clears cookies via the shared util

### Phase 3: Ephemeral connect flow

#### Automated

- [x] 3.1 Linting passes: `npm run lint`
- [x] 3.2 Production build passes: `npx astro sync && npm run build`

#### Manual

- [ ] 3.3 Unchecked connect → DB row, no `gc_sess*` cookies
- [ ] 3.4 Checked connect → `gc_sess*` session cookies, no DB row, live data
- [ ] 3.5 Ephemeral session survives reload but not a new browser session
- [ ] 3.6 MFA account completes challenge in ephemeral mode
- [ ] 3.7 Mode switching clears the other store (both directions)
- [ ] 3.8 Ephemeral sidecar failure shows reconnect/no-stale state
