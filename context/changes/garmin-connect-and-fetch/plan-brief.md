# Garmin Connection + Live Data Fetch (S-01) — Plan Brief

> Full plan: `context/changes/garmin-connect-and-fetch/plan.md`
> Research: `context/changes/garmin-connect-and-fetch/research.md` (+ 3 companion research docs in the same folder)

## What & Why

S-01 is GainPace's **north star**: prove that a runner's real Garmin biometric data can be
fetched live from our stack. The runner connects their Garmin account and sees today's scheduled
workout, their last 3–4 activities, and recovery metrics (sleep, HRV, Body Battery). Every
downstream AI recommendation (S-03/S-04) depends on this data being fetchable — if it's blocked,
the product premise collapses, so it's sequenced first.

## Starting Point

Astro 6 SSR app on Cloudflare Workers with Supabase auth. F-01 (domain schema) is done:
`garmin_credentials` exists with per-user RLS, but holds only scalar OAuth2 token fields. No
domain API routes, no outbound HTTP, no `src/lib/services/` yet — this slice adds the first of each.

## Desired End State

A logged-in runner connects Garmin (credentials + one-time MFA), then sees on their dashboard —
fetched live via a sidecar — their recovery metrics, recent activities, and today's workout (from
the Garmin calendar, or a manual-entry field when none is scheduled). On a Garmin/sidecar failure
they see a graceful "unavailable / reconnect" state backed by the last cached snapshot, never a crash.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Garmin from Workers? | No — off-edge sidecar | March-2026 Cloudflare TLS fingerprinting `403`s all non-browser TLS incl. Workers; only a sidecar can log in | Research |
| Library | `garmin-connect-client` v2.0.0 (orpjones) | Importable lib (vs MCP), MIT, programmatic login + token reuse fits multi-user | Research |
| Infra go/no-go | Accept the sidecar | Recovery data (sleep/HRV/BB) is the product wedge; FR-002 must-have | Plan |
| Hosting | Koyeb (Free) | Free forever (no card), Frankfurt (low PL latency), scale-to-zero, 1–5 s cold start | Plan |
| Data flow | Sidecar owns all Garmin I/O | One auth path; Worker never holds Garmin tokens; fragile API isolated behind our contract | Plan |
| Data scope | Full recovery + best-effort scheduled workout | Proves full hypothesis; honestly handles the no-clean-endpoint gap | Plan |
| No-plan UX | Calendar → manual-entry fallback | No clean "Garmin Coach today" endpoint exists; manual entry keeps the product loop working | Plan |
| Credentials | Encrypted Garmin password + interactive MFA connect | User chose stored-password re-login fallback; primary path is session reuse | Plan |
| Session storage | `session_data JSONB` under RLS, server-only read | Consistent with existing token storage; Supabase at-rest encryption | Plan |
| Fragility | Graceful degradation + last-good snapshot cache + config banner | FR-001: "one Garmin change breaks it" — app must not crash | Plan |
| Testing | Mock-sidecar contract tests + manual live smoke | CI must never hit fragile Garmin (rate-limit/ban risk) | Plan |

## Scope

**In scope:** sidecar (login/MFA/session reuse + recovery/activities/scheduled-workout endpoints),
schema migration (session + encrypted password + snapshot cache), Worker service + JSON API routes,
connect-Garmin UI, dashboard data display, manual-entry fallback, graceful degradation.

**Out of scope:** write-back to Garmin, history UI beyond 3–4 activities, AI recommendations
(S-03), headless-browser auth (documented plan-B only), Strava fallback, app-level encryption of
the session blob.

## Architecture / Approach

Two deployment units. **Sidecar (new, Koyeb):** Node service wrapping `garmin-connect-client` —
does the TLS-impersonated SSO login + token refresh, owns the Garmin session, fills gaps (Body
Battery, calendar) with raw `connectapi.garmin.com` bearer calls, exposes a shared-secret-authed
JSON API. **Worker (this repo):** schema migration + env/config + a `garmin` service that calls
the sidecar over HTTPS, persists/rehydrates session + encrypted password in `garmin_credentials`,
caches the last snapshot, and serves JSON API routes the UI consumes. The Worker never talks to
Garmin directly.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Foundation | Migration (session + enc password + snapshot), types, env vars, config banner, crypto helper | Type regen drift; WebCrypto key handling |
| 2. Sidecar | Koyeb Node service: login/MFA/session + recovery/activities/scheduled-workout | **Proves the hypothesis** — native addon build, real Garmin auth, TLS impersonation |
| 3. Integration | `garmin` service + JSON API routes + mock-sidecar tests | Re-login/MFA fallback logic; session persistence correctness |
| 4. UI | Connect flow (+MFA), dashboard display, manual-entry + degradation states | Cold-start UX vs NFR; no-plan path |

**Prerequisites:** F-01 done (it is); a real Garmin account for manual smoke testing; a Koyeb
account.
**Estimated effort:** ~4 sessions (one per phase); Phase 2 is the riskiest and may need iteration
on the native build + auth.

## Open Risks & Assumptions

- **Fragility (FR-001):** Garmin is unofficial; the March-2026 TLS break already happened once and
  client IDs rotate quarterly. Mitigated by graceful degradation + documented plan-B (headless
  browser), not eliminated.
- **MFA cannot be bypassed by the stored password** — if Garmin re-challenges MFA on re-login, the
  flow must fall back to interactive reconnect. Stored password helps only when MFA isn't re-forced.
- **"Today's Garmin Coach suggested workout" has no stable endpoint** — only manually-scheduled
  calendar workouts are reliable; hence the manual-entry fallback.
- **Koyeb Free limits** (0.1 vCPU / 512 MB, one service, "not for production") and cold start
  (1–5 s) — acceptable for MVP, an upgrade path (Cloud Run / paid) if it bites.

## Success Criteria (Summary)

- A runner connects Garmin (incl. MFA) and sees live recovery, recent activities, and today's
  workout on the dashboard.
- A no-plan day shows manual entry; a sidecar/Garmin outage shows a graceful state with cached
  data — never a crash.
- CI stays green and Garmin-free; live verification is a documented manual smoke test.
