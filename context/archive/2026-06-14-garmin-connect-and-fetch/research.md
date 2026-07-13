---
date: 2026-06-15T00:59:26+02:00
researcher: kzacha
git_commit: fc886d3d315cba014633e8691bda92ad2cf476b9
branch: master
repository: gain-pace
topic: "Which Garmin approach (garmin-connect-mcp vs garmin-connect-client) is compatible with our codebase for S-01"
tags: [research, codebase, garmin, s-01, cloudflare-workers, supabase, sidecar]
status: complete
last_updated: 2026-06-15
last_updated_by: kzacha
---

# Research: garmin-connect-mcp vs garmin-connect-client — codebase compatibility for S-01

**Date**: 2026-06-15T00:59:26+02:00
**Researcher**: kzacha
**Git Commit**: fc886d3d315cba014633e8691bda92ad2cf476b9
**Branch**: master
**Repository**: gain-pace

## Research Question

Review our codebase and decide whether `context/changes/garmin-connect-and-fetch/garmin-connect-mcp-eval.md`
(the etweisberg/robburke MCP server) **or** `context/changes/garmin-connect-and-fetch/garmin-connect-client-api.md`
(orpjones `garmin-connect-client` v2.0.0 library) is compatible with our stack for implementing
roadmap slice **S-01** (Garmin connect + live data fetch).

## Summary

**Neither option can run *inside* our app** — the codebase is confirmed Cloudflare Workers SSR
(V8 isolate), which excludes both the library (native addon) and the MCP (Chromium + process).
So the question isn't "which runs in the Worker" — it's "which is the right engine for the
**off-Workers sidecar** that the prior research already established as the only viable path."

**Verdict: `garmin-connect-client` (orpjones) is the compatible choice — as the sidecar's engine,
not in-Worker.** It wins on the two axes that actually decide fit with our codebase:

1. **Integration shape** — it's an importable library, so it drops into a plain Node sidecar that
   our Worker calls over HTTPS. The MCP is an *MCP server* (stdio) + needs headless Chromium —
   wrong shape for an Astro SSR backend, heavier runtime, and AGPL-3.0.
2. **Auth model for a hosted multi-user product** — its programmatic `login()` + MFA-resume +
   `fromSession`/`onSessionUpdate` token reuse fits "runner connects once, app fetches for weeks."
   The MCP's manual browser login with **few-hour cookie expiry and no refresh** structurally
   cannot serve many runners.

Two codebase-level prerequisites surfaced that **must be resolved before `/10x-plan`**:

- **Schema gap (code-level, fixable):** `garmin_credentials` is OAuth2-scalar only
  (`access_token` / `refresh_token` / `expires_at`) — it **cannot** store
  `garmin-connect-client`'s `PersistedSession` (OAuth1 + OAuth2 + cookies). Needs a migration
  adding a `session_data JSONB` column.
- **Infra contradiction (decision-level, blocking):** *Either* option requires an always-on
  off-edge sidecar, which breaks the documented "pure-Cloudflare-edge, cheapest-path" premise in
  `tech-stack.md` / `infrastructure.md`. This is an owner decision (accept ~$5–10/mo service, or
  descope) and it gates S-01 regardless of library.

## Detailed Findings

### Area 1 — Runtime & deployment (rules out in-Worker for both)

- `astro.config.mjs:11` → `output: "server"`; `astro.config.mjs:16` → `adapter: cloudflare()`.
- `wrangler.jsonc:4` → `"main": "@astrojs/cloudflare/entrypoints/server"`; `wrangler.jsonc:5` →
  `"compatibility_date": "2026-05-08"`; `wrangler.jsonc:6-8` → `"compatibility_flags":
  ["nodejs_compat"]`.
- **Confirmed V8-isolate runtime.** `nodejs_compat` enables some Node APIs but **does not load
  native C/C++ addons** → `node-libcurl-ja3` (the `garmin-connect-client` dependency) cannot run
  in-Worker. **No child processes / filesystem / binaries** → Playwright Chromium (the MCP's
  mechanism) cannot run in-Worker either.
- Env/secrets declared via `envField` in `astro.config.mjs:17-22` (`context:"server",
  access:"secret", optional:true`) and read with `import { … } from "astro:env/server"`
  (`src/lib/supabase.ts:3`). Currently only `SUPABASE_URL`, `SUPABASE_KEY`. CI Node is `22`
  (`.github/workflows/ci.yml:16`), matching `garmin-connect-client`'s `node >=20`.

### Area 2 — `garmin_credentials` schema fit (the schema gap)

`supabase/migrations/20260604000001_create_domain_tables.sql:40-60`:

```sql
CREATE TABLE garmin_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  garmin_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
```

- RLS enabled, all four ops gated by `(select auth.uid()) = user_id`; `anon` revoked
  (`…:52-60, 95`). One row per user (`UNIQUE (user_id)`).
- Types: `src/types/database.ts:23-53`, re-exported as `GarminCredentials` in `src/types.ts:4`.
  Typed client: `createServerClient<Database>(…)` in `src/lib/supabase.ts:10`.
- **Gap:** only scalar OAuth2 token fields; **no JSON/JSONB column.** `garmin-connect-client`'s
  `client.getSession()` returns a `PersistedSession` (OAuth1 + OAuth2 + cookies) — does not fit.
  Fix: `ALTER TABLE garmin_credentials ADD COLUMN session_data JSONB;` (keep scalar columns for
  quick expiry checks, store the full session blob in JSONB). Note `workout_selections` already
  uses a `garmin_data_snapshot JSONB` column — JSONB is an established pattern here.

### Area 3 — Backend integration seam (favors a library/sidecar over an MCP)

- Per-user authenticated client: `createClient(context.request.headers, context.cookies)`
  (`src/lib/supabase.ts:6`); returns `null` when env missing (callers must null-check). RLS
  auto-scopes to the logged-in user.
- `src/middleware.ts:6-16` attaches `context.locals.user`; `PROTECTED_ROUTES = ["/dashboard"]`
  (`:4`) — `/api/garmin/*` would **not** be auto-protected, so the route must check `locals.user`
  itself.
- API route template = `src/pages/api/auth/{signin,signup,signout}.ts` (`export const POST:
  APIRoute`, `createClient(...)` + null-check). These redirect; a JSON data route should follow
  CLAUDE.md (Zod + `new Response`) — it'd be the first JSON API route.
- **No `src/lib/services/` dir and zero outbound HTTP in `src` today** (no `fetch`/axios/undici).
  A Garmin sidecar call would be the first outbound HTTP → set it as the reference pattern.
- Clean seam: `src/lib/services/garmin.ts` (HTTPS `fetch` to the sidecar with a shared-secret
  bearer; `fetch` works in Workers) + `src/pages/api/garmin/*.ts` (per-user client, reads/writes
  `garmin_credentials`), and a `config-status.ts` entry so a missing sidecar URL/secret surfaces a
  banner like Supabase does (`src/lib/config-status.ts:11-21`, `Layout.astro:22-37`).
- This seam suits an **importable library behind an HTTP sidecar**. An **MCP server (stdio)** is
  an awkward fit for a per-request web backend.

### Area 4 — Infra/foundation feasibility (the blocking decision)

- `context/foundation/infrastructure.md:4,17-19` → `recommended_platform: Cloudflare Workers`,
  Free tier `$0/month`, cost-minimization priority; evaluates 6 platforms and picks Workers **over**
  Railway/Fly.io. Does **not** anticipate an additional always-on service.
- `context/foundation/tech-stack.md:8,23-24` → `deployment_target: cloudflare-workers`, "cheapest
  path … for a solo after-hours project"; "background jobs are out of scope per PRD Non-Goals."
- `context/foundation/prd.md` → FR-001 (connect Garmin, must-have, :59), **FR-002 (fetch last 3–4
  activities + sleep, HRV, Body Battery, must-have, :62)**, FR-003 (today's scheduled workout,
  must-have, :68), Access Control "credentials stored per user" (:111), NFR p95 ≤10s (:90). FR-002
  makes Body Battery + HRV non-negotiable → Strava fallback ruled out.
- Prior research (`garmin-library-research.md:76-84`): Worker can't authenticate (Garmin SSO
  behind Cloudflare JA3/JA4 TLS fingerprinting since March 2026); a sidecar must do login +
  OAuth2 refresh; the Worker then hits `connectapi.garmin.com` data endpoints with the bearer
  token (those accept non-browser TLS). Sidecar = the only viable path.

## Compatibility decision matrix

| Dimension (from our codebase) | `garmin-connect-client` (lib) | `garmin-connect-mcp` (MCP) |
|---|---|---|
| Runs in Cloudflare Worker (V8 isolate) | ❌ native `node-libcurl-ja3` | ❌ Chromium + process |
| Integration shape vs Astro SSR backend | ✅ import into Node sidecar, call over HTTPS | ❌ MCP server (stdio); wrong shape |
| Multi-user "connect once, fetch for weeks" auth | ✅ programmatic login + MFA + token reuse | ❌ manual browser login, ~hours cookie expiry, no refresh |
| License | ✅ MIT | ⚠️ AGPL-3.0 (copyleft) |
| Sidecar weight | ✅ plain Node service | ❌ Node + headless Chromium |
| Fits `garmin_credentials` as-is | ⚠️ needs `session_data JSONB` migration | ⚠️ (would also need session storage) |
| S-01 data coverage out of the box | ⚠️ activities + sleep; BB/HRV/workout via raw `connectapi` calls | ✅ native tools incl. standalone HRV + training readiness |
| **Net fit for S-01 in this codebase** | ✅ **chosen — sidecar engine** | ❌ reference/plan-B only |

`garmin-connect-mcp` has *better native data coverage* (standalone HRV, training readiness) but
loses decisively on integration shape and auth. Choosing the library means the sidecar also makes
a few raw `connectapi.garmin.com` calls for Body Battery / HRV / today's workout — already
documented and verified in `garmin-connect-client-api.md` (the library holds the bearer token, so
this is cheap).

## Code References

- `astro.config.mjs:11,16,17-22` — SSR output, Cloudflare adapter, `env.schema` secrets
- `wrangler.jsonc:4-8` — Workers entrypoint, compatibility date, `nodejs_compat`
- `package.json` (engines/deps), `.github/workflows/ci.yml:16,22-24` — Node 22, secret injection
- `supabase/migrations/20260604000001_create_domain_tables.sql:40-60` — `garmin_credentials` + RLS
- `src/types/database.ts:23-53`, `src/types.ts:4` — `GarminCredentials` row type
- `src/lib/supabase.ts:3,6,10` — typed per-user SSR client + `astro:env/server` read pattern
- `src/middleware.ts:4,6-16` — `locals.user`, `PROTECTED_ROUTES`
- `src/pages/api/auth/{signin,signup,signout}.ts` — API route template
- `src/lib/config-status.ts:11-21`, `src/layouts/Layout.astro:22-37` — config banner registry

## Architecture Insights

- The codebase is **already well-shaped for a library-behind-HTTP-sidecar**: per-user RLS-scoped
  Supabase client from cookies, `astro:env/server` secrets, graceful degrade + config banners.
  The missing pieces (`src/lib/services/`, an `/api/garmin/*` JSON route, first outbound `fetch`)
  are net-new but conventional.
- The decisive selector between the two docs is **not data coverage** (where the MCP wins) but
  **integration shape + multi-user auth** (where the library wins) — both of which are properties
  of *our* stack, not of Garmin.
- `garmin-connect-mcp` keeps two residual uses: (1) endpoint reference, (2) documented plan-B —
  if `node-libcurl-ja3` TLS impersonation breaks after a Garmin change, the headless-browser login
  is the resilient fallback for the auth step.

## Historical Context (from prior changes)

- `context/changes/garmin-connect-and-fetch/garmin-library-research.md` — establishes the
  March-2026 Cloudflare TLS-fingerprint block, "Garmin-from-Workers falsified," and the sidecar
  recommendation. This research confirms that conclusion against live config.
- `context/changes/garmin-connect-and-fetch/garmin-connect-client-api.md` — library API surface +
  verified Body Battery / scheduled-workout endpoints + the "no clean today's-Garmin-Coach-workout
  endpoint" caveat (ties to roadmap Open Question 1).
- `context/changes/garmin-connect-and-fetch/garmin-connect-mcp-eval.md` — MCP evaluation; same
  verdict reached here from the codebase side.

## Open Questions

1. **Infra go/no-go (owner decision, blocks S-01):** accept an always-on off-edge sidecar
   (~$5–10/mo, breaks the pure-edge premise) or descope FR-002? This is the top blocker, not a
   library detail.
2. **Roadmap Open Question 1 (no-plan fallback):** even with a Garmin Coach plan, "today's
   suggested workout" has no clean single endpoint. The S-01 scheduled-workout UX must cover
   no-plan, manual-plan, and Coach-plan cases. Owner decision.
3. **Schema migration scope:** confirm `session_data JSONB` addition to `garmin_credentials`
   (vs. a separate table) as part of S-01 planning.
4. **MFA UX:** first-connect MFA is interactive — design the one-time "connect Garmin" flow, then
   token reuse via `fromSession` + re-persist on `onSessionUpdate`.

## Related Research

- `context/changes/garmin-connect-and-fetch/garmin-library-research.md`
- `context/changes/garmin-connect-and-fetch/garmin-connect-client-api.md`
- `context/changes/garmin-connect-and-fetch/garmin-connect-mcp-eval.md`
