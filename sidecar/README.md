# GainPace Garmin sidecar

A tiny off-edge Node service that owns **all** Garmin I/O for GainPace (roadmap slice S-01).

## Why this exists

Since March 2026 Garmin's SSO (`sso.garmin.com`) sits behind Cloudflare JA3/JA4 TLS
fingerprinting, which `403`s every non-browser TLS client — including a Cloudflare Worker's
`fetch()`. So the Astro app (which runs on Cloudflare Workers) **cannot** log into Garmin
directly. This sidecar runs [`garmin-connect-client`](https://www.npmjs.com/package/garmin-connect-client),
which uses the native `node-libcurl-ja3` addon to impersonate a browser's TLS handshake and
perform the SSO login + OAuth2 token refresh. It exposes a small JSON API the Worker calls over
HTTPS with a shared bearer secret.

The Worker never holds Garmin tokens or talks to Garmin directly — it only calls this contract.
The sidecar is **stateless**: it never persists the Garmin session. The session comes in on each
request (from the Worker, which stores it in Supabase) and any refreshed session goes back out in
the response for the Worker to re-persist.

## API

All routes require `Authorization: Bearer <GARMIN_SIDECAR_SECRET>` (including `/health`) → `401` otherwise.

| Method + path | Body | Response |
| --- | --- | --- |
| `GET /health` | — | `{ status: "ok" }` |
| `POST /garmin/login` | `{ username, password }` | `{ status: "ok", session }` or `{ status: "mfa_required", pending }` or `400 { status: "invalid_credentials" }` |
| `POST /garmin/login/mfa` | `{ pending, mfaCode }` | `{ status: "ok", session }` or `400 { status: "mfa_invalid" }` |
| `POST /garmin/activities?limit=4` | `{ session }` | `{ status: "ok", activities[], session? }` |
| `POST /garmin/recovery?date=YYYY-MM-DD` | `{ session }` | `{ status: "ok", recovery, session? }` |
| `POST /garmin/scheduled-workout?date=YYYY-MM-DD` | `{ session }` | `{ status: "ok", workout \| null, session? }` |

**Note on verbs:** the data endpoints are `POST` (not `GET` as first sketched in the plan) because
the persisted session — OAuth tokens + cookies — is too large to travel safely in a query string
or header. Paths and query params otherwise match the plan.

`session?` in a response means the library rotated tokens during that request; the Worker **must**
re-persist the returned `session`.

The `pending` blob from `/garmin/login` is self-contained (`{ mfaRequired: true, cookies }`), so the
two-step MFA flow survives the sidecar scaling to zero / landing on a different instance between the
two calls — the Worker just holds `pending` and sends it back to `/garmin/login/mfa`.

## Environment

| Var | Purpose |
| --- | --- |
| `GARMIN_SIDECAR_SECRET` | Shared bearer the Worker must send. Long random string. **Required.** |
| `PORT` | Listen port. Cloud Run sets this automatically (8080). |

## Run locally

```bash
cd sidecar
npm install                 # builds the native addon — needs a Linux/macOS toolchain (see note)
export GARMIN_SIDECAR_SECRET="dev-secret-change-me"
npm run dev                 # tsx watch, listens on :8080

# in another shell:
curl -s localhost:8080/health -H "Authorization: Bearer dev-secret-change-me"   # → {"status":"ok"}
curl -s localhost:8080/health                                                    # → 401
```

> **Windows note:** `node-libcurl-ja3` is a native addon that generally will **not** `npm install`
> cleanly on Windows. Develop against the Docker image (below) or WSL. This is expected and is the
> whole reason the sidecar is containerized.

## Build the Docker image

```bash
cd sidecar
docker build -t gainpace-garmin-sidecar .
docker run --rm -p 8080:8080 -e GARMIN_SIDECAR_SECRET=dev-secret gainpace-garmin-sidecar
curl -s localhost:8080/health -H "Authorization: Bearer dev-secret"              # → {"status":"ok"}
```

## Deploy to Google Cloud Run (free tier)

Cloud Run scales to zero (you pay nothing when idle) and its perpetual free tier covers a personal
MVP comfortably. A billing account with a card is required, but **within the free tier you are not
charged**. Region **`europe-central2` (Warsaw)** gives the lowest latency from Poland.

### One-time setup

1. **Create / pick a Google Cloud project.**
   - Go to <https://console.cloud.google.com/> → top project dropdown → **New Project**.
   - Name it e.g. `gainpace`. Note the **Project ID** (looks like `gainpace-472913`) — you'll need it.
2. **Enable billing** (required even for free tier; you won't be charged within limits).
   - Left menu → **Billing** → link a billing account (add a card if prompted).
3. **Install the gcloud CLI** and log in.
   - Download: <https://cloud.google.com/sdk/docs/install> → run the installer.
   - Then in a terminal:
     ```bash
     gcloud auth login                       # opens a browser to sign in
     gcloud config set project <PROJECT_ID>  # e.g. gainpace-472913
     ```
   > Tip: in this Claude Code session you can run an interactive login by typing
   > `! gcloud auth login` in the prompt.
4. **Enable the APIs** Cloud Run + Cloud Build need:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```

### Create the shared secret (do NOT bake it into the image)

1. Generate a long random secret and store it in Secret Manager:
   ```bash
   # generate one (any long random string works):
   openssl rand -base64 48
   # store it (paste the value when prompted, or pipe it):
   printf '%s' 'PASTE_THE_RANDOM_VALUE' | gcloud secrets create GARMIN_SIDECAR_SECRET --data-file=-
   ```
2. Keep this same value — the Worker's `GARMIN_SIDECAR_SECRET` (in `.dev.vars` / Cloudflare secret)
   must match it exactly.

### Deploy

From the repo root (Cloud Build builds the Dockerfile in `sidecar/` for you — no local Docker needed):

```bash
gcloud run deploy garmin-sidecar \
  --source ./sidecar \
  --region europe-central2 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --memory 512Mi \
  --cpu 1 \
  --set-secrets GARMIN_SIDECAR_SECRET=GARMIN_SIDECAR_SECRET:latest
```

- **What you should see:** Cloud Build streams the Docker build, then Cloud Run prints
  `Service [garmin-sidecar] revision [...] has been deployed and is serving 100 percent of traffic.`
  followed by a **Service URL** like `https://garmin-sidecar-xxxxxxxx-lm.a.run.app`.
- `--allow-unauthenticated` means *Cloud Run's* IAM layer won't block requests — our **own** bearer
  secret is the guard (that's `requireAuth`). Without it, only Google-signed callers could reach the
  service, which the Worker isn't.
- `--min-instances 0` → scales to zero (free when idle). Cold start is ~1–5 s; the connect/fetch UI
  shows progress for this (PRD NFR: any op > 2 s must show visible progress).

### Verify the deployment

```bash
SERVICE_URL="https://garmin-sidecar-xxxxxxxx-lm.a.run.app"   # from the deploy output
curl -s "$SERVICE_URL/health"                                          # → 401
curl -s "$SERVICE_URL/health" -H "Authorization: Bearer <YOUR_SECRET>" # → {"status":"ok"}
```

Then set the Worker's `GARMIN_SIDECAR_URL` to `$SERVICE_URL` (see repo root `.env.example`).

### Rotating the secret later

```bash
printf '%s' 'NEW_RANDOM_VALUE' | gcloud secrets versions add GARMIN_SIDECAR_SECRET --data-file=-
gcloud run services update garmin-sidecar --region europe-central2 \
  --set-secrets GARMIN_SIDECAR_SECRET=GARMIN_SIDECAR_SECRET:latest
# then update the Worker's GARMIN_SIDECAR_SECRET to match.
```

## Security posture

This service is internet-reachable and will log into any Garmin account it's given credentials for —
the bearer secret is the only guard. If it leaks, it becomes an open Garmin-login proxy. Mitigations:
long random secret, stored as a Cloud Run secret (not in the image), rotated on suspicion of leak.
Accepted for the MVP; revisit (e.g. restrict ingress) if the service is ever scaled up.

## Live verification results (Phase 2 manual gate — done 2026-07-13)

Verified against a real Garmin account, both locally (Docker) and on the deployed Cloud Run service.
Findings that shaped the current `src/` code:

- **Raw `connectapi` headers work.** `Authorization` + `User-Agent` + `NK: NT` on
  `connectapi.garmin.com` return `200` for Body Battery, the calendar, and sleep — no `403`. The
  plain OAuth2 bearer is accepted on this host (only `sso.garmin.com` is TLS-fingerprint blocked).
- **Sleep is fetched via raw REST, not the library.** `client.sleep.getDailySleepData` zod-validates
  a strict enum (`sleepNeed.trainingFeedback`) that Garmin extends server-side
  (`TODAYS_LOAD_AND_CHRONIC`, unknown to the lib) → it throws and yields all-null. We call
  `/sleep-service/sleep/dailySleepData?date=&nonSleepBufferMinutes=60` directly and pluck
  defensively. **`avgOvernightHrv` is at the response root**, not under `dailySleepDTO`.
- **Scheduled workouts use `itemType: "fbtAdaptiveWorkout"`.** Garmin Coach adaptive-plan workouts
  (the common case) appear in `calendar-service` under this type with `workoutId: null` and the label
  in `title`; the filter now matches it alongside `workout`/`scheduledWorkout`.
- **The GraphQL gateway is NOT usable from the sidecar.** `connect.garmin.com/gc-api/graphql-gateway`
  (`sleepSummariesScalar`, `workoutScheduleSummariesScalar`, `healthStatusSummary`) `403`s the OAuth2
  bearer — it only works in-browser with cookies. All data stays on `connectapi.garmin.com` REST.
- **Unattended re-login:** the test account has **no MFA**, so `login({username,password})` returns a
  session directly — the encrypted-password re-login path is usable. Phase 3 still handles an
  `mfa_required` response by surfacing a "reconnect Garmin" state (for MFA-enabled accounts).
- **MFA-across-restart (row 2.8): not exercised** — the test account has no MFA challenge to resume.
  The `pending` blob (`{ mfaRequired: true, cookies }`) is self-contained by construction, so resume
  across a scale-to-zero restart should hold; confirm if an MFA-enabled account becomes available.
