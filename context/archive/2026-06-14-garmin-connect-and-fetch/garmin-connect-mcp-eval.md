# Evaluation: `garmin-connect-mcp` (etweisberg / robburke) — mapped to S-01

> Fetched 2026-06-15 (exa) from both repos + the npm package `@etweisberg/garmin-connect-mcp`
> (v0.1.22) and commit `f02ae01` (endpoint paths). Companion to `garmin-library-research.md` and
> `garmin-connect-client-api.md`. **`robburke/garmin-connect-mcp` is a fork of
> `etweisberg/garmin-connect-mcp` with no tool-surface divergence** — identical 27 tools, same
> architecture, same auth. Everything below applies to both.

## TL;DR for planning

This is an **MCP server** (not a library) that bypasses the March-2026 Cloudflare TLS block by
tunnelling every API call through a **headless Playwright Chromium** browser (real Chrome TLS
fingerprint). Its **data coverage is the best of any option we've looked at** — including the
standalone HRV and training-readiness that `garmin-connect-client` lacks. But its **auth model
is a hard mismatch for GainPace**: a *manual, interactive browser login* whose cookies **expire
after a few hours**, with **no headless credential login and no token refresh**. It is built for
one developer querying their own account from Claude Code, **not for a hosted product connecting
many runners**. Useful to us as a **reference for the endpoint catalog and the Playwright
TLS-bypass technique**, not as a drop-in integration.

## What it is (architecture)

- TypeScript MCP server, **AGPL-3.0** (copyleft — note for any code reuse), stdio transport.
- All calls run **inside headless Chromium** via `page.evaluate(fetch(...))` against
  `connect.garmin.com/gc-api/*`, inheriting the browser's TLS fingerprint to defeat Cloudflare.
- **Auth flow:** call `garmin-login` → it drives the separate **Playwright MCP server** to open
  Garmin Connect for a **manual human login** → captures cookies + CSRF token → saves to
  `~/.garmin-connect-mcp/session.json`. `check-session` validates it.
- **Prerequisites:** Node 18+, the Playwright MCP server, a Chromium binary, filesystem for the
  session, and a Garmin account with a synced device.

## Fit against GainPace's stack & S-01 — three blockers

1. **Not Cloudflare Workers-compatible** (same conclusion as every other option): needs Chromium
   + filesystem + a long-lived process. Would have to run as a **heavy sidecar** (a container,
   not edge). Heavier than the `garmin-connect-client` sidecar (which is a plain Node service; no
   browser).
2. **It's an MCP server, not a client library.** GainPace is an Astro SSR app, not an MCP host.
   To consume it you'd run it as an MCP server and have the backend speak MCP/stdio to it
   (awkward for a web request path), or lift its endpoint-calling code (AGPL constraints apply).
   No `import`-and-call API like `garmin-connect-client`.
3. **Auth model is unsuitable for a multi-user hosted product** — the decisive blocker:
   - Login is **manual and interactive** (a human logging in through a browser), not a
     programmatic credential/OAuth flow we can run per runner on signup.
   - Session cookies **expire after a few hours** and must be **re-captured manually** — the
     README says so explicitly. There is **no token refresh**.
   - Designed for a single developer's own account on their own machine. GainPace needs to
     connect *many* runners once and fetch on their behalf for weeks → fundamentally different.

## S-01 data coverage (excellent — the one strong point)

S-01 needs: today's scheduled workout, last 3–4 activities, recovery (sleep, HRV, Body Battery).

| S-01 need | Tool | Notes |
|---|---|---|
| Last 3–4 activities | `list-activities`, `get-activity`, `get-activity-details`, `get-activity-splits` | ✅ full |
| Sleep quality | `get-sleep` (score, duration, stages, SpO2), `get-sleep-stats` | ✅ full |
| HRV | `get-hrv` | ✅ **standalone HRV** — better than `garmin-connect-client` (sleep-scoped only) |
| Body Battery | `get-body-battery` (charged/drained) | ✅ full |
| (bonus) Training readiness | `get-training-readiness` | ✅ composite recovery score — useful S-03 context |
| Today's scheduled workout | `get-calendar` (monthly: activities + events), `list-workouts`, `get-workout` | ⚠️ covers **manually-scheduled** workouts; **no "today's Garmin Coach suggested workout" tool** — same gap confirmed in `garmin-connect-client-api.md` |

Full tool set also includes: daily summary / heart-rate / stress / respiration / intensity-
minutes / movement, weight, personal records, fitness stats, VO2max, HR & power zones, user
profile, goals, badges, and workout create/schedule/delete/download-FIT (writes — out of S-01
scope). 27 tools total.

## Verified endpoint paths (from commit `f02ae01`) — reusable regardless of this tool

Base host in browser context: `connect.garmin.com/gc-api/...` (vs `connectapi.garmin.com` for
direct bearer-token calls documented in `garmin-connect-client-api.md`). Paths align:

- `get-training-readiness` → `GET metrics-service/metrics/trainingreadiness/{date}`
- `get-sleep-stats` → `GET sleep-service/stats/sleep/daily/{startDate}/{endDate}`
- `list-workouts` → `GET workout-service/workouts?start=&limit=`
- `get-workout` → `GET workout-service/workout/{id}`
- `schedule-workout` → `POST workout-service/schedule/{workoutId}` body `{ date }`
- `get-calendar` → monthly calendar (year / **0-indexed** month)

## Verdict

**Do not adopt as the integration mechanism for S-01.** The Playwright auth model (manual login,
few-hour cookie expiry, no refresh) can't support a hosted multi-user connect-once flow, and an
MCP server is the wrong integration shape for an Astro SSR backend. Compared with
`garmin-connect-client` (orpjones), this MCP has **better data coverage** (standalone HRV +
training readiness) but a **far worse auth fit** and a heavier runtime (full Chromium).

**Where it's still useful:**
- **Endpoint reference** — confirms/extends the verified paths in `garmin-connect-client-api.md`
  (training readiness, sleep-stats, workout/calendar). Same "no Garmin-Coach-today" gap.
- **Fallback bypass technique** — if the `node-libcurl-ja3` TLS impersonation in
  `garmin-connect-client` stops working after a future Garmin change, the **headless-browser
  approach is the proven plan-B** for the login handshake (heavier, but resilient to TLS-only
  blocks). Keep it on the shelf for the sidecar.

> Net recommendation unchanged from `garmin-connect-client-api.md`: build the **sidecar** around
> `garmin-connect-client` for programmatic login + token reuse, fill the Body-Battery / scheduled-
> workout gaps with raw `connectapi.garmin.com` calls, and treat this MCP's browser-login approach
> as the documented plan-B for auth resilience.

## Sources

- `etweisberg/garmin-connect-mcp` README + tools: https://github.com/etweisberg/garmin-connect-mcp
- `robburke/garmin-connect-mcp` (fork, no divergence): https://github.com/robburke/garmin-connect-mcp
- npm: https://www.npmjs.com/package/@etweisberg/garmin-connect-mcp (v0.1.22, AGPL-3.0)
- Endpoint paths: commit `f02ae01` "Add 14 new tools" — https://github.com/etweisberg/garmin-connect-mcp/commit/f02ae01c26a6dad0be33fd94e7a6cce2b9666e61
- Adjacent MCPs (credential+MFA + long-lived tokens, python-garminconnect-based, for comparison):
  `github.com/Nicolasvegam/garmin-connect-mcp` (61 tools), `github.com/bmccarn/garmin-mcp-server`
  (34 tools, "tokens last ~1 year", MFA)
