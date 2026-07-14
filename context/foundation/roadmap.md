---
project: "GainPace"
version: 1
status: draft
created: 2026-06-04
updated: 2026-07-14
prd_version: 1
main_goal: market-feedback
top_blocker: external
---

# Roadmap: GainPace

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

GainPace addresses a gap in the structured running market: every current tool gives a runner exactly one prescribed workout for today, forcing a binary choice between compliance and reality. GainPace is a lightweight modifier layer — the runner sets three simple inputs (time available, intensity preference, how they feel), and the app generates three AI-powered alternatives, each with a plain-language explanation of what it trades against the runner's actual recovery state and race goal.

The product's wedge — the one trait that, if removed, makes it indistinguishable from a generic AI chatbot — is that every recommendation is grounded in the runner's own Garmin biometric data (HRV, Body Battery, sleep quality) and their stated long-term race goal, not generic training advice.

## North star

**S-01: Garmin connection + data fetch** — proves that the unofficial Garmin API can be reliably called from a Cloudflare Workers JS runtime to surface a runner's real biometric and activity data.

> *North star* here means the first slice whose successful delivery would prove the core product hypothesis — placed as early as Prerequisites allow because everything else only matters if this works. For GainPace, every downstream AI recommendation depends on live Garmin data being fetchable; if this integration is blocked, the product premise collapses before any UI investment is warranted.

## At a glance

| ID   | Change ID                    | Outcome (user can …)                                                                                                             | Prerequisites | PRD refs                      | Status   |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------- | -------- |
| F-01 | domain-schema                | (foundation) domain tables in Supabase with RLS enabled per user                                                                 | —             | FR-001, FR-007, FR-008        | ready    |
| S-01 | garmin-connect-and-fetch     | connect their Garmin account and see today's scheduled workout + recent activity data fetched live                               | F-01          | FR-001, FR-002, FR-003, US-01 | done     |
| S-02 | race-goal-setup              | define their long-term race goal (event, date, distance, target time)                                                            | F-01          | FR-008, US-01                 | done     |
| S-03 | modifier-to-recommendation-loop | set today's modifiers and receive 3 AI-generated workout alternatives with plain-language explanations, then select one       | S-01, S-02    | FR-004, FR-005, FR-007, US-01 | done     |
| S-04 | training-arc-context         | see how each of the 3 alternatives affects their long-term training arc toward their race goal                                   | S-03          | FR-006, US-01                 | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme             | Chain                              | Note                                                                         |
| ------ | ----------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| A      | Integracja Garmin | `F-01` → `S-01` → `S-03` → `S-04` | Główna oś north star — całe AI zależy od danych Garmin z tego łańcucha.      |
| B      | Cel treningowy    | `S-02`                             | Zależy od F-01 (ze Streamu A); dołącza do Streamu A jako drugie wejście S-03. |

## Baseline

What's already in place in the codebase as of 2026-06-04 (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 6 SSR + React 19 islands; pages: `src/pages/index.astro`, `src/pages/dashboard.astro`, `src/pages/auth/*.astro`; auth UI components present
- **Backend / API:** partial — only auth API routes (`src/pages/api/auth/{signin,signup,signout}.ts`); no domain-level routes or services
- **Data:** partial — Supabase client wired (`src/lib/supabase.ts`); no domain schema or migrations yet (`supabase/config.toml` schema_paths empty)
- **Auth:** present — Supabase SSR cookie sessions; middleware at `src/middleware.ts` protects `/dashboard`
- **Deploy / infra:** present — Cloudflare Workers via `wrangler.jsonc` + `astro.config.mjs` cloudflare adapter; GitHub Actions CI at `.github/workflows/ci.yml`
- **Observability:** absent — no logging library, error tracking, or metrics

## Foundations

### F-01: Domain schema and migrations

- **Outcome:** (foundation) Supabase migration files created for three domain tables — `race_goals`, `workout_selections`, `garmin_credentials` — with RLS policies enabled per table, scoped per authenticated user.
- **Change ID:** domain-schema
- **PRD refs:** FR-001 (garmin_credentials table for OAuth token storage), FR-007 (workout_selections table to persist today's chosen workout), FR-008 (race_goals table for race goal data), Access Control section (per-user credential storage requirement)
- **Unlocks:** S-01 (garmin_credentials table required to persist OAuth tokens after Garmin connect), S-02 (race_goals table required to save runner's race goal), S-03 (workout_selections table required to persist the runner's chosen workout)
- **Prerequisites:** —
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Sequenced first because every downstream slice reads or writes domain data. If RLS policies are misconfigured, credentials or workout selections could leak across users — a hard regression per PRD Access Control. Low implementation risk; migrations are straightforward SQL.
- **Status:** ready

## Slices

### S-01: Garmin connection + data fetch

- **Outcome:** runner can connect their Garmin account via OAuth and see today's scheduled workout from their Garmin training plan alongside recent activity data — last 3–4 workouts, plus recovery metrics (sleep quality, HRV, Body Battery) — fetched live.
- **Change ID:** garmin-connect-and-fetch
- **PRD refs:** FR-001, FR-002, FR-003, US-01
- **Prerequisites:** F-01
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:** (both resolved during `/10x-plan`, 2026-06-15 — see `context/changes/garmin-connect-and-fetch/plan.md`)
  - ~~No official Garmin API; the viable JS/TS approach must be identified.~~ **Resolved:** Garmin-from-Workers is falsified (March-2026 Cloudflare TLS fingerprinting blocks all non-browser TLS, incl. Workers). Chosen approach: an off-edge **sidecar** on Koyeb (Free) running `garmin-connect-client` v2.0.0 for login + token refresh, owning all Garmin I/O behind a clean JSON API the Worker calls over HTTPS.
  - ~~PRD Open Question 1: no-plan fallback UX.~~ **Resolved:** there is no clean "today's Garmin Coach suggested workout" endpoint; show the manually-scheduled calendar workout when present, else fall back to manual entry of today's planned workout.
- **Risk:** Highest-risk slice in the roadmap — the entire product hypothesis depends on live Garmin data being fetchable. The unofficial API is explicitly fragile per FR-001 Socrates note: "one server-side change breaks the integration." Mitigated in the plan via graceful degradation + last-good snapshot cache; the headless-browser auth path is kept as a documented plan-B.
- **Status:** done

### S-02: Race goal setup

- **Outcome:** runner can define their long-term race goal — event name, event date, target distance, and target finish time — stored per account and retrievable as AI context.
- **Change ID:** race-goal-setup
- **PRD refs:** FR-008, US-01
- **Prerequisites:** F-01
- **Parallel with:** S-01
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Low-risk, self-contained CRUD slice with no external dependencies. Sequenced in parallel with S-01 so goal data is ready when S-03 fires the first AI recommendation. Risk: if the form allows implausible inputs (past event date, zero distance), the AI prompt in S-03 receives malformed context — basic input validation needed.
- **Status:** done

### S-03: Modifier screen → AI recommendation loop → selection

- **Outcome:** runner can set today's modifiers (Time available / Intensity preference / Feeling), receive a primary AI-recommended workout card plus 2 alternatives — each with a plain-language explanation grounded in their Garmin recovery metrics and active modifiers — and select one as today's committed workout; the whole flow completes within 3 user actions on the modifier screen.
- **Change ID:** modifier-to-recommendation-loop
- **PRD refs:** FR-004, FR-005, FR-007, US-01
- **Prerequisites:** S-01, S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - AI safety guardrail: the PRD requires that the AI must not recommend a volume or intensity implausible given the runner's last 3–4 logged activities. The prompt design and structured output validation approach for this guardrail must be decided before implementation to avoid shipping a hard regression. — Owner: user. Block: no.
- **Risk:** This slice integrates all upstream data — Garmin activity and recovery data, race goal, and real-time modifiers — into a single LLM call with structured output. The 10-second p95 NFR applies directly to this call. The riskiest failure mode is prompt-induced hallucination: a recommendation that sounds plausible but violates the guardrail (e.g., prescribing 30 km for a 5 km/week runner). Sequenced after S-01 and S-02 so both data sources are available in the prompt.
- **Status:** done

### S-04: Training arc context per recommendation

- **Outcome:** runner can see a one-line training-arc note alongside each of the 3 workout alternatives, explaining how today's choice affects their long-term progress toward their defined race goal.
- **Change ID:** training-arc-context
- **PRD refs:** FR-006, US-01
- **Prerequisites:** S-03
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Extends the S-03 AI prompt with an additional output field (training arc reasoning per alternative). Low risk if S-03's structured output response schema is designed to include this field from the start. Risk: if S-03 ships with a schema that omits this field, retrofitting it requires a prompt change and a response schema migration across both slices.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                    | Suggested issue title                                                              | Ready for `/10x-plan` | Notes                                                          |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| F-01       | domain-schema                | [GainPace] Domain schema: race_goals, workout_selections, garmin_credentials (RLS) | yes                   | Run `/10x-plan domain-schema`                                  |
| S-01       | garmin-connect-and-fetch     | [GainPace] Garmin OAuth connect + live data fetch (north star)                     | yes (planned)         | Planned 2026-06-15 — sidecar (Koyeb) + manual-entry fallback. Run `/10x-implement garmin-connect-and-fetch phase 1` |
| S-02       | race-goal-setup              | [GainPace] Race goal setup form + persistence                                      | yes                   | Run `/10x-plan race-goal-setup`; can start in parallel         |
| S-03       | modifier-to-recommendation-loop | [GainPace] Modifier screen → AI recommendation loop → workout selection          | no                    | Proposed: S-01 + S-02 must ship first                         |
| S-04       | training-arc-context         | [GainPace] Training arc one-liner per AI recommendation                            | no                    | Proposed: S-03 must ship first                                 |

## Open Roadmap Questions

1. ~~**Co się dzieje gdy runner nie ma aktywnego planu Garmin Coach?**~~ **ROZWIĄZANE (2026-06-15, `/10x-plan` S-01).** Nie istnieje czysty endpoint na "dzisiejszy sugerowany trening z Garmin Coach" — niezawodnie pobieralne są tylko ręcznie zaplanowane treningi z kalendarza. Decyzja: wybrano opcję (a) — pokaż trening z kalendarza gdy istnieje, w przeciwnym razie fallback do ręcznego wpisania dzisiejszego planu. Szczegóły: `context/changes/garmin-connect-and-fetch/plan.md` (Faza 4).

2. ~~**Jak wywoływać Garmin Connect API z JS/TS na Cloudflare Workers?**~~ **ROZWIĄZANE (2026-06-15, `/10x-plan` S-01).** Garmin-z-Workerów jest niewykonalne — od marca 2026 Garmin SSO jest za fingerprintingiem TLS (JA3/JA4) Cloudflare, który blokuje każdy nie-przeglądarkowy klient TLS (w tym `fetch()` Workera). Decyzja: osobny **sidecar** poza edge (Koyeb Free) z `garmin-connect-client` v2.0.0 robi login + odświeżanie tokenów i obsługuje całe I/O Garmina za czystym JSON API; Worker woła tylko sidecar przez HTTPS. Szczegóły: `context/changes/garmin-connect-and-fetch/plan.md`.

## Parked

- **Push do zegarka Garmin (.fit write-back)** — Why parked: PRD §Non-Goals. Automatic upload to Garmin training calendar is explicitly post-MVP.
- **Generowanie 12-tygodniowego planu treningowego** — Why parked: PRD §Non-Goals. Full periodization planning out of scope.
- **Własny algorytm obciążenia treningowego (ATL/CTL)** — Why parked: PRD §Non-Goals. App uses LLM contextual reasoning instead of a physiological load model.
- **Funkcje społecznościowe** (tablice wyników, udostępnianie, kudos) — Why parked: PRD §Non-Goals. Personal training assistant, not a social platform.
- **Historia treningów dla runnera (FR-002b)** — Why parked: demoted to nice-to-have in PRD Socrates round. AI context fetch (FR-002) is the load-bearing piece; the history display UI is a UX enhancement for a later iteration.

## Done

- **S-01: runner can connect their Garmin account via OAuth and see today's scheduled workout from their Garmin training plan alongside recent activity data — last 3–4 workouts, plus recovery metrics (sleep quality, HRV, Body Battery) — fetched live.** — Archived 2026-07-13 → `context/archive/2026-06-14-garmin-connect-and-fetch/`. Lesson: —.
- **S-02: runner can define their long-term race goal — event name, event date, target distance, and target finish time — stored per account and retrievable as AI context.** — Archived 2026-07-14 → `context/archive/2026-07-14-race-goal-setup/`. Lesson: —.
- **S-03: runner can set today's modifiers (Time available / Intensity preference / Feeling), receive a primary AI-recommended workout card plus 2 alternatives — each with a plain-language explanation grounded in their Garmin recovery metrics and active modifiers — and select one as today's committed workout; the whole flow completes within 3 user actions on the modifier screen.** — Archived 2026-07-14 → `context/archive/2026-07-14-modifier-to-recommendation-loop/`. Lesson: —.
