# Research: JS/TS Garmin Connect libraries for S-01 on Cloudflare Workers

> Change: `garmin-connect-and-fetch` (roadmap S-01). Researched 2026-06-15 via web search (Exa).
> Question: which JS/TS libraries can implement S-01 (Garmin OAuth connect + live fetch of
> today's workout, recent activities, and recovery metrics) compatibly with `tech-stack.md`
> (Astro 6 SSR on Cloudflare Workers, TypeScript, Supabase)?

## Headline finding — the blocker sits *under* the library choice

In **March 2026**, Garmin put their SSO/auth endpoints behind **Cloudflare TLS (JA3/JA4)
fingerprinting**. This blocks *all non-browser HTTP clients* — Node.js `fetch`, `undici`,
`axios`, Python `requests`, `curl` — with a `403`, *before any request headers are read*.

Corroboration (cross-source):

- Garmin community forum thread (2026-03-30) confirming the server-side change:
  https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/433892/tls-fingerprinting-blocks-third-party-clients/2025622
- `garth` (the canonical Python token library) was **officially deprecated** as a result;
  `python-garminconnect` broke simultaneously (issues #337 / #217).
- Cloudflare Workers docs: a Worker's `fetch()` uses Cloudflare's own TLS stack — **not** a
  browser fingerprint — so a Worker hitting Garmin SSO is blocked exactly like Node `fetch`.
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/

**Consequence for our stack:** the roadmap's core assumption — "call the unofficial Garmin API
directly from a Cloudflare Workers JS runtime" — is **not viable as of 2026**. It is not a
library-maturity problem. The Workers V8-isolate runtime cannot produce an accepted TLS
handshake against Garmin's login, and it cannot host any of the workarounds (no native addons,
no headless browser, no child processes).

**Key nuance** (from the `orpjones/garmin-connect-client` v2.0.0 rewrite, Apr 2026): only the
**SSO login handshake** (`sso.garmin.com`) is CF-fingerprint-blocked. The data endpoints
(`connectapi.garmin.com`, `diauth.garmin.com`) accept non-browser TLS *once you hold a valid
OAuth2 bearer token*. So the blocker is specifically **authentication**, not the subsequent
data fetch. This is the architectural lever (see Recommendation).

## Library landscape (all unofficial — no public Garmin API exists)

| Library | Maintained | Handles March-2026 auth block? | Data coverage (sleep / HRV / Body Battery / workouts) | Runs on CF Workers? |
|---|---|---|---|---|
| **`garmin-connect`** (Pythe1337N lineage; `GeorgeTG` fork pushed 2026-05; `@flow-js/garmin-connect` ~1.2k wk dl) | active | ❌ relies on Node TLS for login → CF-blocked | ✅ best — 60+ methods, OAuth1/2, MFA, token reuse | ❌ Node-only |
| **`garmin-connect-client`** (orpjones, v2.0.0 2026-04) | active | ✅ **only JS lib that explicitly fixes it** — `node-libcurl-ja3` (Chrome TLS impersonation) for SSO, axios for API | ✅ read-only: activities, sleep, HRV, stress | ❌ needs native libcurl binding |
| **`garmin-connect-sdk`** (marcel-tuinstra) | alpha | ❌ Node 24 password login | ✅ read + experimental workout write | ❌ Node-only |
| **`ts-watches`** (stacksjs) | active | ❌ | ✅ multi-vendor + full FIT parsing (heavy) | ❌ Node-only |
| **`garmin-connect-mcp`** (etweisberg/robburke) | active | ✅ via **headless Playwright** (real Chrome TLS) | ✅ full (activities, sleep, Body Battery, HRV, workouts, training readiness) | ❌ needs Chromium + filesystem |
| **`garmin-data-bridge`** (Flo976) | active | ✅ via **patchright** headed browser + `xvfb` | ✅ full, webhook push | ❌ Linux-only browser, residential IP |

**None are Cloudflare Workers-compatible.** Every approach that survives the March-2026 block
requires either a native TLS-impersonation binary (`node-libcurl-ja3`, `got-scraping`,
`node-tls-client`, `hellojs`) or a real browser (Playwright / patchright) — none of which exist
in the Workers V8 isolate.

### Supporting evidence on the TLS layer

- `orpjones/garmin-connect-client` v2.0.0 commit (2026-04-17) — design notes: "Garmin's SSO is
  behind Cloudflare. Only Chrome TLS fingerprints are allowed, so we use `libcurl-impersonate`
  for SSO steps … `connectapi.garmin.com` don't CF-block non-browser TLS." Also rotates
  quarterly device-identity client IDs; exchanges service ticket directly for OAuth2 (no OAuth1).
- "How to Bypass Cloudflare with TLS Fingerprinting in Node.js" (dev.to, 2026-02): rotating
  User-Agent / headers fails because CF checks TLS *first*; standard Node TLS API can't replicate
  Chrome's ClientHello. Options: `got-scraping`, `curl-impersonate`, `node-tls-client`.

## Updated verdicts on roadmap S-01 unknown #2 (the four options)

1. **Community JS wrapper, called from the Worker** — ❌ dead. Library exists (`garmin-connect`)
   but the Worker cannot authenticate (CF TLS block).
2. **Raw HTTP from the Worker** — ❌ dead. Same TLS block.
3. **Thin proxy / sidecar service** — ✅ **the only viable path.** A small always-on Node service
   (Fly.io / Railway / container — *not* Workers) performs the CF-impersonation login + OAuth2
   token refresh, then either (a) proxies data calls, or (b) returns the bearer token so the
   Worker fetches `connectapi.garmin.com` directly. `orpjones/garmin-connect-client` v2.0.0 is
   the closest off-the-shelf fit for that sidecar.
4. **Strava API fallback** — ✅ viable de-risk: official OAuth, Workers-friendly — **but no sleep
   / HRV / Body Battery**, which guts the product wedge (recovery-grounded recommendations).

## Recommendation

Treat S-01's "Garmin-from-Workers" assumption as **falsified**. Working hypothesis for planning:
a **sidecar architecture** —

- Always-on Node service (off Workers) using a TLS-impersonation client (`node-libcurl-ja3` via
  `garmin-connect-client`, or a headless-browser approach) for **login + token refresh**.
- Persist OAuth2 tokens in Supabase (`garmin_credentials`, already created in F-01).
- Worker fetches data endpoints directly with the bearer token (those accept non-browser TLS),
  or calls the sidecar's clean API.

### Implications to flag before planning

- **Breaks the `tech-stack.md` premise** of a pure-Cloudflare-edge, cheapest-path deploy: an
  extra always-on service adds cost and ops surface for a solo after-hours MVP.
- **Fragility risk is now concrete** (matches FR-001's "one server-side change breaks the
  integration"): the March-2026 break already happened once; Garmin rotates client IDs quarterly
  and is actively locking down third-party access (tied to Garmin Connect+ subscription).
- **MFA**: most token flows require an interactive MFA step at first login — needs a one-time
  manual connect UX, then token reuse/refresh.
- **Still open (roadmap Open Question 1):** no-plan fallback UX when the runner has no active
  Garmin Coach training plan (blocks FR-003 design) — unaffected by this research, still needs a
  product decision.

## Sources

- Garmin forum — TLS fingerprinting block: https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/433892/tls-fingerprinting-blocks-third-party-clients/2025622
- `garth` deprecation discussion: https://github.com/matin/garth/discussions/222
- Cloudflare Workers Node.js compat: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Cloudflare Workers fetch: https://developers.cloudflare.com/workers/runtime-apis/fetch/
- `garmin-connect` (GeorgeTG fork): https://github.com/GeorgeTG/garmin-connect
- `garmin-connect-client` (orpjones, v2.0.0 auth rewrite): https://github.com/orpjones/garmin-connect-client + commit 9c696bc
- `garmin-connect-sdk` (marcel-tuinstra): https://github.com/marcel-tuinstra/garmin-connect-sdk
- `garmin-connect-mcp` (etweisberg/robburke): https://github.com/robburke/garmin-connect-mcp
- `garmin-data-bridge` (Flo976): https://github.com/Flo976/garmin-data-bridge
- TLS bypass overview (dev.to, 2026-02): https://dev.to/datakaz/how-to-bypass-cloudflare-with-tls-fingerprinting-in-nodejs-2pb2
