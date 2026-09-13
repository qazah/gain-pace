# GainPace

**Today's workout, adapted to the day you're actually having.**

Garmin Coach and similar structured plans hand you exactly one prescribed workout for today. You either follow it or break the plan — there is no middle path that respects your long-term goal while fitting a bad night's sleep, a packed calendar, or simply wanting a different effort level.

GainPace is that middle path. It reads your recent training and last night's recovery from Garmin, takes three modifiers for today (**time available**, **intensity**, **how you feel**), and proposes workout alternatives — each with a plain-language explanation of what it trades away, and a line about how today's choice moves your long-term training arc. You pick one and it becomes today's committed workout.

It is built for the committed recreational runner training toward a race or a benchmark: not an elite with a human coach, not a beginner building a first habit.

## What it actually does

- **Connects to Garmin** and pulls recent activities, overnight recovery (sleep, HRV, body battery) and today's scheduled workout.
- **Takes today's constraints** as three modifiers rather than a questionnaire.
- **Generates alternatives with an LLM**, ranked best-fit-first, each carrying a workout type, duration, structured steps with target paces, and an explanation grounded in your recovery state and goal proximity.
- **Refuses to recommend nonsense.** Every option is checked against guardrails derived from the runner's own recent history — a 180-minute session for someone whose recent runs are 40 minutes never reaches the screen. An option that fails the check is dropped and the smaller set ships flagged as reduced, rather than failing the request.
- **Records the choice** as today's committed workout.

## How it is put together

An **Astro 6 SSR app on Cloudflare Workers**. Every page is server-rendered; React 19 is used only for interactive islands, Astro components for layout and static content.

Two design decisions worth knowing before reading the code:

- **The Worker never talks to Garmin directly.** Garmin has no official API for this data, so an off-edge **sidecar** (`sidecar/`, deployed separately) owns the Garmin session and exposes a small internal contract. The Worker holds no Garmin tokens; it calls the sidecar. See `src/lib/services/garmin.ts`.
- **Credentials are opt-in.** A runner can connect in a **cookie-only** mode where the Garmin session lives in encrypted cookies and no server-side credential row is ever created. The stored mode persists an encrypted row instead. Both satisfy the same `SessionStore` interface (`src/lib/services/garmin-session-store.ts`).

The recommendation logic lives in two modules worth reading first: `src/lib/recommendation-guardrail.ts` (framework-free domain rules — plausibility bands, pace validation, response parsing) and `src/lib/services/recommendations.ts` (prompt assembly, bounded retry loop, failure taxonomy, graceful degradation).

## Tech Stack

- [Astro](https://astro.build/) v6 — server-first rendering, `output: "server"`
- [React](https://react.dev/) v19 — interactive islands only
- [TypeScript](https://www.typescriptlang.org/) v5
- [Tailwind CSS](https://tailwindcss.com/) v4 + [shadcn/ui](https://ui.shadcn.com/) (new-york style)
- [Supabase](https://supabase.com/) — auth and Postgres, with RLS on every domain table
- [Anthropic Claude](https://www.anthropic.com/) — recommendation generation with structured output
- [Cloudflare Workers](https://workers.cloudflare.com/) — deployment runtime
- [Vitest](https://vitest.dev/) — tests; [Stryker](https://stryker-mutator.io/) as an ad-hoc mutation gate

## Prerequisites

- Node.js v22.14.0 (see `.nvmrc`)
- npm
- [Docker](https://www.docker.com/) and ~7 GB RAM, if you want to run Supabase locally

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Set up Supabase — see [Supabase Configuration](#supabase-configuration) below.

3. Create your env files. The Vite/Node dev path reads `.env`; the Cloudflare workerd runtime reads `.dev.vars`:

```bash
cp .env.example .env
cp .env.example .dev.vars
```

4. Run the dev server:

```bash
npm run dev
```

> **Verifying React islands:** `astro dev` double-bundles React and breaks island hydration in this project. To check anything interactive, use `npm run build && npm run preview` instead. Note that `preview` reads `dist/server/.dev.vars` — a copy made at build time — so changing a secret requires a rebuild, not just an edit.

## Environment Variables

All are declared in `astro.config.mjs` via Astro's `env.schema` as **server-only secrets**, and are read with `import { X } from "astro:env/server"` — never from `process.env`. Each is optional: when one is missing the corresponding feature degrades and `src/lib/config-status.ts` surfaces a banner instead of the app crashing.

| Variable                  | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `SUPABASE_URL`            | Project URL (dashboard → Settings → API)               |
| `SUPABASE_KEY`            | `anon` public key (dashboard → Settings → API)         |
| `ANTHROPIC_API_KEY`       | Recommendation generation                              |
| `GARMIN_SIDECAR_URL`      | Base URL of the deployed sidecar                       |
| `GARMIN_SIDECAR_SECRET`   | Shared secret authenticating the Worker to the sidecar |
| `GARMIN_PASSWORD_ENC_KEY` | Server key encrypting a stored Garmin password         |

## Available Scripts

| Script             | What it does                                                             |
| ------------------ | ------------------------------------------------------------------------ |
| `npm run dev`      | Dev server on the Cloudflare workerd runtime                             |
| `npm run build`    | Production build (SSR via `@astrojs/cloudflare`)                         |
| `npm run preview`  | Preview the production build locally                                     |
| `npm test`         | Vitest, single run, scope `src/**/*.test.ts`                             |
| `npm run lint`     | ESLint with type-checked rules                                           |
| `npm run lint:fix` | Auto-fix lint issues                                                     |
| `npm run format`   | Prettier (astro + tailwind plugins)                                      |
| `npx astro check`  | Type-check — **not** in CI, and the only thing that catches a type error |
| `npx stryker run`  | Mutation testing, scoped to the two recommendation modules               |

## Project Structure

```
.
├── src/
│   ├── pages/            # Astro pages
│   │   └── api/          # API endpoints (uppercase GET/POST exports, Zod-validated)
│   ├── components/       # UI components (Astro & React)
│   │   ├── ui/           # shadcn/ui primitives
│   │   └── hooks/        # React hooks
│   ├── lib/              # Business logic
│   │   └── services/     # Garmin, recommendations, race goals, selections
│   ├── test/             # Shared hermetic test environment
│   ├── middleware.ts     # Attaches the resolved user to context.locals
│   └── types.ts          # Shared entity/DTO types
├── sidecar/              # Off-edge Garmin service (deployed separately)
├── supabase/migrations/  # Schema, RLS policies, grants
├── context/              # Product and process foundation — see below
└── wrangler.jsonc        # Cloudflare Workers config
```

Path alias: `@/*` → `./src/*`. Class names are merged with `cn()` from `@/lib/utils` — never concatenated by hand.

## Database

Four domain tables: `garmin_credentials`, `race_goals`, `workout_selections`, `recommendation_usage`.

**Row Level Security is enabled on all of them**, with per-operation, per-role policies scoped on `(select auth.uid()) = user_id` — 16 policies in total. New tables must follow the same rule and also be granted to the `authenticated` role, or the app will read empty results with no error.

Migrations live in `supabase/migrations/` and are named `YYYYMMDDHHmmss_description.sql`. Apply them with:

```bash
npx supabase db push
```

## Supabase Configuration

### Local stack (no cloud project needed)

```bash
npx supabase start     # downloads Docker images on first run
```

Copy the printed credentials into `.env` and `.dev.vars`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon key from CLI output>
```

Studio is at `http://localhost:54323`. Stop the stack with `npx supabase stop`.

### Cloud project

Take `SUPABASE_URL` and the `anon` key from dashboard → Settings → API.

Two settings that bite in practice:

- **Site URL** must point at your deployed Worker. Signup does not pass an explicit redirect, so confirmation links follow whatever Site URL says — leave it on `localhost` and confirmation mails will too.
- **Free-tier projects pause after inactivity**, which removes their DNS record. The symptom is the whole app failing at once with `status: 0` fetch errors and `internal error; reference=…` in the logs. Fix: dashboard → the project → **Restore project**. The anon key does not change.

### Email confirmation

By default Supabase requires email confirmation before sign-in. To skip it in local development: **Authentication → Email → Confirm email**, toggle off.

### Auth routes

| Route                 | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `/auth/signin`        | Email/password sign-in                                       |
| `/auth/signup`        | Email/password sign-up                                       |
| `/auth/confirm-email` | Post-signup "check your inbox" page                          |
| `/dashboard`          | Protected — redirects to `/auth/signin` when unauthenticated |

Route protection lives in `src/middleware.ts`; add paths to `PROTECTED_ROUTES` to require auth. Every API route additionally checks `context.locals.user` itself.

## Testing

Tests are written against defined risks, not for coverage. The risk register and the rollout strategy live in `context/foundation/test-plan.md`; each test traces back to a numbered risk there.

```bash
npm test                 # whole suite
npx stryker run          # mutation gate, ad hoc — never in CI
```

The suite is hermetic: no network, no database, no model calls. `src/test/recommendation-env.ts` assembles the three seams the recommendation service needs — a fake `SessionStore`, a table-aware fake Supabase, and a stubbed sidecar `fetch` — plus an injectable model client. `context/foundation/test-plan.md` §6.1 documents the patterns and the traps.

Mutation testing is a **selective** gate: run it after a risk phase, read the survived mutants, and kill only the ones that would hurt a runner. Chasing the score produces tests that pin implementation details.

## Deployment

```bash
npm run build
npx wrangler deploy
```

Set every variable from the table above as a Worker secret (`npx wrangler secret put <NAME>`, or via the Cloudflare dashboard). The sidecar deploys separately — see `sidecar/README.md`.

## CI

GitHub Actions runs `astro sync → lint → build → test` on every push and PR to `master`; a failing test fails the build. `SUPABASE_URL` and `SUPABASE_KEY` are required as repository secrets for the build step (tests run with no secrets present).

**`npx astro check` is not in CI.** Lint, build and test have all passed on a type error before, shipping a 500 to production. Run it yourself before claiming a change type-checks.

## Further reading

The product and process foundation this app was built from lives in `context/foundation/`:

| Document            | What it holds                                               |
| ------------------- | ----------------------------------------------------------- |
| `prd.md`            | Problem, persona, success criteria, functional requirements |
| `shape-notes.md`    | The discovery conversation the PRD came from                |
| `roadmap.md`        | Milestones and vertical slices                              |
| `tech-stack.md`     | Why this stack                                              |
| `infrastructure.md` | Deployment platform comparison                              |
| `test-plan.md`      | Risk register, rollout phases, and the testing cookbook     |

Completed changes are archived under `context/archive/`, each with its plan, research and implementation review.

## License

MIT
