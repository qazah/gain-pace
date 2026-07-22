# Garmin Credential Control & Privacy — Plan Brief

> Full plan: `context/changes/garmin-credential-control/plan.md`

## What & Why

Give runners control over their stored Garmin credentials: a **disconnect** action that wipes everything server-side, and a **"don't store my credentials" opt-out** that keeps the Garmin session in browser cookies only. Motivation: GainPace currently persists a runner's Garmin session and encrypted password with no way to remove them and no privacy alternative (roadmap S-07).

## Starting Point

Today `garmin.ts` reads and writes the Garmin session, encrypted password, and cached snapshot directly to the `garmin_credentials` table (DB-only). There is no disconnect path, and connecting always persists to the DB. Cookies are handled only by `@supabase/ssr` in `src/lib/supabase.ts`; a Workers-native AES-GCM helper already exists in `garmin-crypto.ts`.

## Desired End State

A connected runner can disconnect (after a confirm), wiping their `garmin_credentials` row and any session cookies while leaving goals/workouts intact. At connect time they can tick "don't store my credentials," after which the session lives only in encrypted, session-scoped cookies — connected within the browser session, re-authenticating on the next one. Default (stored) mode is unchanged.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Slice structure | One combined slice | Disconnect + opt-out share the connect/credential surface | Frame |
| Data hygiene | Strict — nothing server-side in ephemeral mode; disconnect deletes the whole row | Cleanest privacy story | Frame |
| Cookie storage | Chunk full session across 2–3 cookies | Blob is ~5.6–8.3 KB encrypted; preserves cookie jar so refresh/rehydration match stored mode | Plan |
| Opt-out default | Unchecked (store by default) | Keeps the good default UX (silent re-login); privacy is opt-in | Plan |
| Disconnect UX | Confirm first | Destructive and hard to reverse | Plan |
| Mode switching | Mutually exclusive — each connect clears the other store | One source of truth per user; honors the privacy choice | Plan |
| Ephemeral failure | Reconnect/error, no stale data | Consistent with strict hygiene (no snapshot cached) | Plan |
| MFA in cookie mode | Supported — pending blob rides the cookie | MFA users get privacy mode too | Plan |
| Testing | Manual only | User preference for this change | Plan |

## Scope

**In scope:** disconnect (service + route + UI); a `SessionStore` seam with DB and cookie implementations; encrypted chunked session-cookie utility; the ephemeral opt-out checkbox and its wiring through connect/MFA/data; MFA-in-cookie; fixing a stale migration comment.

**Out of scope:** any schema/migration change; caching a snapshot in cookie mode; silent re-login in cookie mode; new automated tests; sidecar changes; persisting the opt-out as a remembered preference.

## Architecture / Approach

A `SessionStore` abstraction normalizes load/persist/snapshot/clear of a Garmin session. `DbSessionStore` reproduces today's `garmin_credentials` behavior; `CookieSessionStore` encrypts+chunks the session into session-scoped cookies (no password, no snapshot). `garmin.ts`'s connect/MFA/fetch functions take a store; API routes select DB vs cookie per request (connect from the `ephemeral` flag, mfa/data by detecting which store holds a session). Mutual exclusivity keeps at most one store populated per user.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Disconnect | Confirm-gated disconnect: service + `/api/garmin/disconnect` + UI | Low — scoped delete |
| 2. Session-store seam + cookie util | `SessionStore` refactor (DB store = no change) + encrypted chunked cookie util | Regressing the load-bearing stored-mode fetch path |
| 3. Ephemeral connect flow | `ephemeral` flag, store selection, MFA-in-cookie, no-snapshot failure, checkbox UI | Chunk roundtrip / mode-detection edge cases |

**Prerequisites:** S-01 (garmin-connect-and-fetch) shipped — done. `GARMIN_PASSWORD_ENC_KEY` configured (already used by `garmin-crypto.ts`).
**Estimated effort:** ~2–3 sessions across 3 phases.

## Open Risks & Assumptions

- **Chunk/reassemble is the one silent-corruption spot** and is untested per the manual-only decision — if a cookie-mode session ever fails to rehydrate, add a fast-follow unit test for the encrypt→chunk→read roundtrip.
- Assumes the ~4 KB per-cookie / 2–3 chunk estimate holds; a runner with an unusually large cookie jar could need more chunks (the util derives chunk count dynamically, so this degrades gracefully).
- Assumes the sidecar can rehydrate its client from the cookie-preserved session identically to the DB-preserved one (same blob, different storage) — verified structurally, confirmed in Phase 3 manual testing.

## Success Criteria (Summary)

- A runner can disconnect and see all their server-side Garmin data removed.
- A runner can connect without any server-side credential storage and stays connected only for the browser session.
- Default stored-mode behavior (silent re-login, MFA, snapshot fallback) is unchanged.
