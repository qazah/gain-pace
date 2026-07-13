<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Garmin Connection + Live Data Fetch (S-01)

- **Plan**: context/changes/garmin-connect-and-fetch/plan.md
- **Scope**: Full plan (Phases 1–4)
- **Date**: 2026-07-13
- **Verdict**: NEEDS ATTENTION (all findings triaged + fixed)
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING (F1, F2 — fixed) |
| Architecture | PASS |
| Pattern Consistency | WARNING (F2 — fixed) |
| Success Criteria | PASS (automated green; manual live rows pending) |

## Findings

### F1 — Session death triggers up to 3 concurrent re-logins

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/lib/services/garmin.ts:294-301
- **Detail**: After a silent re-login the retry response carries no `session` (the sidecar only echoes it on mid-request token rotation), so the parallel activities+scheduled calls reused the dead session and each re-logged-in again — up to 3 Garmin logins per dashboard load, with racing persistSession upserts.
- **Fix**: After the recovery fetch, reload the row (reLogin already persisted the fresh session) and build `rowForRest` from it — guarantees at-most-once re-login.
- **Decision**: FIXED (Fix now)

### F2 — data route: unencoded `date` + missing Zod validation

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Security, low) + Pattern Consistency
- **Location**: src/pages/api/garmin/data.ts:27 → garmin.ts:294,300
- **Detail**: `date` from searchParams flowed unencoded into the sidecar URLs; connect.ts/mfa.ts Zod-validate their input but data.ts did not.
- **Fix**: Zod-validate the `date` param (YYYY-MM-DD) in data.ts + `encodeURIComponent` in the service.
- **Decision**: FIXED (Fix now)

### F3 — No unit test for the MFA-re-challenge → reconnect branch

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/lib/services/garmin.test.ts
- **Detail**: Tests covered re-login success + stale fallback but not reLogin → ReconnectRequiredError on an MFA re-challenge (named in the plan's Testing Strategy).
- **Fix**: Added a test: dead session → /garmin/login returns mfa_required → expect getDashboardData reconnectRequired:true.
- **Decision**: FIXED (Fix now)

### F4 — Unconfigured / MFA-dead sessions masked as connected+stale

- **Severity**: OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Correctness
- **Location**: src/lib/services/garmin.ts:318-331
- **Detail**: The catch dropped `reconnectRequired` whenever a cached snapshot existed, so an MFA-dead session showed "stale data" instead of a reconnect CTA.
- **Fix**: Preserve `reconnectRequired` alongside cached data in the service; GarminDashboard now shows the reconnect prompt above the (stale) data instead of replacing it. (Unconfigured-sidecar case left to the global config banner + stale state, which is acceptable.)
- **Decision**: FIXED (Map errors distinctly)

### F5 — Sidecar timeout/network error → HTTP 500 on connect/mfa

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Reliability
- **Location**: src/pages/api/garmin/connect.ts:48, mfa.ts:47
- **Detail**: AbortController(20s)/network errors weren't `instanceof GarminError`, so the route's `throw err` yielded 500.
- **Fix**: callSidecar now catches abort/network failures and rethrows as GarminError → routes map to 502.
- **Decision**: FIXED (Fix now)

### F6 — Unchecked `res.pending as MfaPending` cast

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Reliability
- **Location**: src/lib/services/garmin.ts:168
- **Detail**: A malformed `mfa_required` response (no `pending`) would store `undefined` in session_data.
- **Fix**: Strengthened `isPending` to require `cookies:string` and guard the blob before storing; throw GarminError otherwise.
- **Decision**: FIXED (Fix now)

## Notes

- Also noted (no action): `expiresAtIso`'s >1e12 epoch heuristic — `expires_at` is written but never read for a re-login decision.
- Verified correct: authz on all 3 routes, RLS + user_id filter, no secret/password/session leakage to the client, `onConflict:"user_id"` matches the UNIQUE constraint, AbortController cleared in `finally`, pending-vs-session guards, no scope creep in Worker code.
- Manual/live verification rows (1.8, 2.8, 3.6–3.8, 4.4–4.8) remain pending — they require a running app + sidecar.
