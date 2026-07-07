# API reference: `garmin-connect-client` (orpjones) v2.0.0 — mapped to S-01

> Fetched 2026-06-15 from the published v2.0.0 package (npm + `dist/*.d.ts` via jsDelivr) and
> the GitHub README. Companion to `garmin-library-research.md`, which selected this library as
> the closest off-the-shelf fit for the **sidecar** that performs Garmin login + token refresh.
> Package: `npm i garmin-connect-client` · repo: https://github.com/orpjones/garmin-connect-client
> · npm: https://www.npmjs.com/package/garmin-connect-client · `engines: node >=20`.

## TL;DR for planning

This is a **read-only** Garmin client. Its v2.0.0 public surface covers **activities** and
**sleep** well, but **does NOT have fetch methods for Body Battery, standalone HRV status, or
today's scheduled workout / training plan** — two of which S-01 explicitly requires. The
wellness data shapes (`BodyBattery`, `HeartRate`, `HrvStatus`, `TrainingStatus`,
`UserDailySummary`, …) are *exported as types/Zod schemas only* — there is no client getter to
fetch them, and the public API exposes **no raw `.get()` escape hatch** to reach those endpoints
yourself. See the gap table below before committing the S-01 scope.

## Runtime constraint (carry-over, decisive)

- Hard dependency on **`node-libcurl-ja3`** (native libcurl binding for Chrome TLS/JA3
  impersonation) + `axios` + `tough-cookie`. Native addon + `node >=20` ⇒ **cannot run in the
  Cloudflare Workers V8 isolate**. This library lives in the **sidecar** (Fly.io / Railway /
  container), never in the Worker. Confirms `garmin-library-research.md` §Recommendation.
- Per the research notes: only the **SSO login** (`sso.garmin.com`) needs the TLS impersonation;
  `connectapi.garmin.com` accepts a plain bearer token. So the Worker *can* call data endpoints
  directly once the sidecar hands it a valid OAuth2 token — relevant to the gaps below.

## Install & dependencies

```bash
npm install garmin-connect-client
```

Deps: `axios`, `axios-cookiejar-support`, `tough-cookie`, `node-libcurl-ja3`, `form-data`,
`luxon` (dates are `luxon.DateTime`), `qs`, `zod` (response validation).

## Authentication (top-level functions from `index`)

```typescript
import { login, fromSession } from 'garmin-connect-client';

// 1. Credentials login
const result = await login({ username, password });
// result: LoginSuccess { mfaRequired: false; client } | MfaPending { mfaRequired: true; cookies: string }

// 2. Resume if MFA challenge was issued
const client = result.mfaRequired
  ? await login(result, mfaCode)   // second overload: login(pending, mfaCode)
  : result.client;
```

Signatures (from `dist/index.d.ts`):

- `login(config: GarminConnectClientConfig): Promise<LoginResult>` — `config = { username, password }`
- `login(pending: MfaPending, mfaCode: string): Promise<LoginResult>` — resume after MFA
- `fromSession(session: PersistedSession): GarminConnectClient` — restore client, **no network call**
- Error classes exported: `MfaRequiredError`, `MfaCodeInvalidError`, `InvalidCredentialsError`,
  `OAuthTokenError`, `NotAuthenticatedError`, `HttpError`, `CsrfTokenError`, … (`./errors`)

### Session persistence (the load-bearing pattern for the sidecar)

```typescript
const session = client.getSession();          // PersistedSession = OAuth tokens + cookies
// → persist to Supabase garmin_credentials (F-01). Treat like a password.

const restored = fromSession(sessionData);     // rehydrate, no login round-trip
client.onSessionUpdate((s) => save(s));         // fires when tokens auto-refresh → re-persist
```

> MFA is interactive on first connect ⇒ S-01 needs a one-time manual "connect Garmin" UX, then
> token reuse via `fromSession` + re-persist on `onSessionUpdate`.

## Full client method surface (from `dist/client.d.ts` — authoritative)

| Method | Returns | S-01 use |
|---|---|---|
| `getActivities(start?, limit?)` | `Promise<Activity[]>` | ✅ recent activities — `getActivities(0, 4)` |
| `getActivity(id: string)` | `Promise<Activity>` | ✅ single activity detail |
| `get sleep` (sub-client) | `GarminConnectSleepClient` | ✅ recovery (sleep) — see below |
| `getSession()` | `PersistedSession` | ✅ token persistence |
| `onSessionUpdate(cb)` | `void` | ✅ re-persist refreshed tokens |
| `getGolfActivities / getGolfScorecardDetail / getGolfRounds` | golf types | ❌ irrelevant |

### Sleep sub-client (`dist/sleep/client.d.ts`)

```typescript
const daily = await client.sleep.getDailySleepData(DateTime.now()); // DailySleepData
daily.dailySleepDTO.sleepScores.overall.value;                       // overall sleep score
const stats = await client.sleep.getSleepStats(from, to);            // SleepStats over a range
```

- `getDailySleepData(date?: DateTime, nonSleepBufferMinutes?): Promise<DailySleepData>`
- `getSleepStats(from: DateTime, to: DateTime): Promise<SleepStats>`
- The sleep payload's exported sub-types include `hrv-adjustment`, `wellness-epoch-sp02-data`,
  `wellness-epoch-respiration-data` — i.e. **HRV appears only as a sleep-scoped adjustment**, not
  as a standalone HRV-status reading.

## S-01 data requirements → coverage gap analysis

S-01 outcome needs: **(a)** today's scheduled workout from the Garmin training plan, **(b)** last
3–4 activities, **(c)** recovery metrics: sleep quality, HRV, Body Battery.

| S-01 need | v2.0.0 support | Notes |
|---|---|---|
| (b) Last 3–4 activities | ✅ `getActivities(0, 4)` + `getActivity(id)` | Fully covered |
| (c) Sleep quality | ✅ `sleep.getDailySleepData()` | Score + stages + stats |
| (c) HRV | ⚠️ partial | Only `hrvAdjustment` inside the sleep payload; **no** standalone HRV-status fetch. `HrvStatus` enum is exported but unused by any getter |
| (c) Body Battery | ❌ **no fetch method** | `BodyBattery` type/schema is exported, but no `getBodyBattery()` on the client |
| (a) Today's scheduled workout / training plan | ❌ **absent** | No `getWorkouts` / calendar / training-plan method at all. Library is read-only and does not model the Garmin Coach plan |

### Consequence

Two of S-01's data points — **Body Battery** and **today's scheduled workout** — are not
reachable through this library's public API, and there is **no exposed raw-request method** to
fetch them yourself (unlike the Pythe1337N `garmin-connect` lib, which exposes `GCClient.get()`).
Options to close the gap, to decide before `/10x-plan`:

1. **Sidecar makes custom calls** — have the sidecar (which already holds the impersonated TLS
   session + OAuth2 token) issue raw `connectapi.garmin.com` requests for Body Battery
   (`/wellness-service/wellness/bodyBattery/...`) and the training-plan/scheduled-workout
   endpoints, alongside this library's typed methods. Most pragmatic; keeps one auth path.
2. **Worker fetches the gap endpoints directly** — sidecar returns the bearer token; the Worker
   calls `connectapi.garmin.com` for Body Battery + scheduled workout (those accept non-browser
   TLS per the research). Splits data fetching across two runtimes.
3. **Reduce S-01 scope** — ship activities + sleep first (fully supported), defer Body Battery /
   HRV-status / scheduled-workout. Ties into roadmap **Open Question 1** (no-plan fallback UX),
   which already questions whether the scheduled-workout view survives at all.

> Recommendation: option 1 — let the sidecar own all Garmin I/O (typed methods where they exist,
> raw `connectapi` calls for the gaps) so the Worker only ever talks to our own clean API.

## Verified gap endpoints (Body Battery + scheduled workout)

> Verified 2026-06-15 against `python-garminconnect` (cyberjunky, 131+ documented endpoints —
> the most complete public catalog), cross-checked with the GeorgeTG `garmin-connect` fork,
> `etweisberg/garmin-connect-mcp`, and `llehouerou/go-garmin`. All paths are relative to
> `https://connectapi.garmin.com` and called with the OAuth2 bearer token (no TLS impersonation
> needed on the data host — only SSO login needs it). These are the raw calls the **sidecar**
> (option 1) would make to fill the two gaps `garmin-connect-client` doesn't cover.

### Body Battery — ✅ fully reachable (3 ways)

| Data | Method + path | Notes |
|---|---|---|
| BB daily report (time series) | `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | `endDate` optional ⇒ single day. Returns per-day BB level series |
| BB events | `GET /wellness-service/wellness/bodyBattery/events/{YYYY-MM-DD}` | Sleep / activity / nap events that charged or drained BB |
| BB current/high/low (embedded) | `GET /usersummary-service/usersummary/daily/{displayName}?calendarDate=YYYY-MM-DD` | Daily summary also carries most-recent/charged/drained BB — one call for several recovery metrics |

For a single-day recovery snapshot, `bodyBattery/reports/daily` with `startDate=endDate=today`
is the direct fetch.

### Scheduled workout / training plan — ⚠️ reachable, but "today's suggested workout" is the catch

| Data | Method + path | Notes |
|---|---|---|
| Scheduled workouts for a month (calendar) | `GET /calendar-service/year/{year}/month/{month}` | **`month` is 0-indexed** (Jan = 0). Returns scheduled workouts + activities + events for the month — filter to today's date client-side |
| Day-level calendar | `GET /calendar-service/year/{year}/month/{month}/day/{day}/start/{n}` | Day view variant (per `go-garmin`); month-level above is what `python-garminconnect` ships |
| A scheduled workout by id | `GET /workout-service/schedule/{scheduledWorkoutId}` | Full step/segment detail of one scheduled item |
| Saved workout templates | `GET /workout-service/workouts?start=0&limit=100` · one: `GET /workout-service/workout/{id}` | The runner's workout library |
| Training plans list | `GET /trainingplan-service/trainingplan/plans` | All available plans |
| Training plan detail | `GET /trainingplan-service/trainingplan/phased/{planId}` | Structured (phased) plan |
| **Garmin Coach adaptive plan** | `GET /trainingplan-service/trainingplan/fbt-adaptive/{planId}` | Adaptive Garmin Coach plan detail (`fbt-adaptive`) |
| Schedule / unschedule (write — out of S-01 scope) | `POST /workout-service/schedule/{workoutId}` body `{"date":"YYYY-MM-DD"}` · `DELETE /workout-service/schedule/{scheduledWorkoutId}` | For reference only — S-01 is read |

**Critical caveat — there is no clean endpoint for "today's suggested workout from Garmin
Coach"** (the daily recommended workout shown on the Connect dashboard). Confirmed by
cyberjunky `home-assistant-garmin_connect` **issue #305** (still open): no method exists; the
maintainer speculates `/trainingplan-service/schedule/today` or
`/workout-service/schedule/date/{date}` but neither is verified. Consequences for S-01's "today's
scheduled workout from their Garmin training plan":

- **Manually-scheduled workouts** → fully covered: query `calendar-service` for today's date.
- **Garmin Coach adaptive plan** → the *daily suggested* workout has **no stable single call**.
  You'd pull `fbt-adaptive/{planId}` and derive today's session, or reverse-engineer the
  dashboard XHR (fragile). This **sharpens roadmap Open Question 1** (no-plan fallback): even a
  runner *with* a Coach plan can't have "today's workout" fetched in one reliable call — so the
  no-plan-vs-plan UX decision now also has to cover "has a plan, but the daily workout isn't
  cleanly fetchable." Recommend resolving OQ-1 with this constraint in hand before `/10x-plan`.

## Sources

- npm: https://www.npmjs.com/package/garmin-connect-client (v2.0.0, published Apr 17 2026)
- Endpoint verification — `python-garminconnect` (`garminconnect/__init__.py`):
  https://github.com/cyberjunky/python-garminconnect · scheduled-workouts PR #343 · "today's
  suggested workout" gap: cyberjunky/home-assistant-garmin_connect issue #305
- Cross-checks: `github.com/GeorgeTG/garmin-connect`, `github.com/etweisberg/garmin-connect-mcp`,
  `github.com/llehouerou/go-garmin`
- Type surface: `dist/index.d.ts`, `dist/client.d.ts`, `dist/sleep/index.d.ts`,
  `dist/sleep/client.d.ts` via https://cdn.jsdelivr.net/npm/garmin-connect-client@2.0.0/
- `package.json` (deps, `node >=20`): https://github.com/orpjones/garmin-connect-client/blob/main/package.json
