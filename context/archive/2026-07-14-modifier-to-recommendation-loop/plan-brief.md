# Modifier → AI Recommendation Loop → Selection — Plan Brief

> Full plan: `context/changes/modifier-to-recommendation-loop/plan.md`

## What & Why

S-03 — the core product loop and the slice the whole hypothesis rests on. The runner sets today's three modifiers (Time / Intensity / Feeling); the app makes **one Claude Haiku 4.5 structured-output call** fusing their Garmin recovery + last-4 activities + active race goal + modifiers; it returns a **primary workout + 2 "if you prefer" alternatives** with plain-language explanations; the runner selects one, persisted to `workout_selections`. A plausible-load guardrail defends the PRD's hard-regression (never recommend an implausible volume/intensity vs recent activity).

## Starting Point

All inputs exist and are done: `getDashboardData` (S-01) supplies recovery + activities + scheduled workout; `getActiveRaceGoal` (S-02) supplies the goal; the `workout_selections` table exists but is unused. There is **no LLM anywhere** — no SDK, no key, no client. This slice introduces the first LLM integration and the first Zod validation of a *response* (all prior Zod validates requests).

## Desired End State

On `/dashboard`, a runner with a goal + connected Garmin sees a modifier screen, gets three validated recommendations within the 10s p95 budget (with skeleton progress), and commits one as today's workout. Implausible AI output never reaches the runner; missing prerequisites show a CTA instead of calling the AI; the flow is ≤3 actions.

## Key Decisions Made

| Decision                | Choice                                                              | Why (1 sentence)                                                                          | Source |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------ |
| LLM provider/model      | Anthropic Claude Haiku 4.5 (`@anthropic-ai/sdk`, structured output) | Schema-guaranteed output serves the guardrail; strongest instruction-following; cheap/fast | Plan   |
| Safety guardrail        | Prompt + schema-validate + plausible-load check + one bounded retry | Defends the hard-regression in depth without unbounded latency                            | Plan   |
| Guardrail double-fail   | Treat as failure → error + Retry, **no fabricated workout**         | A fabricated/canned load could be unsafe and breaks the AI-wedge                          | Plan   |
| Prerequisites           | Gate + degrade (CTA if no goal/connection; recommend if recovery missing) | Never send malformed/empty context to the AI; clear next action                     | Plan   |
| Modifier input          | Segmented chips + time presets                                     | Maps 1:1 to DB enums; keeps the flow within ≤3 actions                                    | Plan   |
| Loading UX              | Skeleton cards + staged status copy                                | Perceived-performance + satisfies the >2s continuous-progress NFR                         | Plan   |
| Persistence             | One row/day, latest selection wins (edit-in-place, no migration)   | Matches "today's committed workout"; the schema's `alternative_rank` is built for it       | Plan   |
| Regeneration            | Free, with a soft per-user daily cap                               | Supports the modifier-experiment loop while bounding paid-API spend                       | Plan   |
| S-04 arc note           | Schema-ready field + existing nullable column; left null in S-03   | Zero prompt/schema/DB migration when S-04 lands                                           | Plan   |
| Testing                 | Unit-test the guardrail/validation + lint/build + manual           | Deterministically covers the hard-regression logic without flaky live-LLM calls           | Plan   |
| Observability           | Structured server logs (latency, tokens, guardrail hits)           | Watch the 10s NFR and catch guardrail violations via `wrangler tail`                      | Plan   |

## Scope

**In scope:** `ANTHROPIC_API_KEY` config + banner; `recommendation_usage` migration (daily cap); framework-free guardrail module (+ unit tests); recommendations service (Claude call, structured output, validate + one bounded retry, logging); `POST /api/recommendations`; workout-selection service + `GET`/`POST /api/recommendations/select`; the modifier→skeleton→results→commit island + dashboard wiring; DTOs.

**Out of scope:** training-arc note generation/display (S-04); .fit write-back; streaming reveal; canned fallback workout; goal history; a mocked-LLM/eval harness; a past-selections view.

## Architecture / Approach

Three phases, risk front-loaded. The recommendations service orchestrates: load Garmin + goal → check daily cap → build a frozen-system + volatile-user prompt → Claude structured-output call (~9s timeout) → `astro/zod` parse → framework-free plausible-load guardrail → one bounded re-prompt on violation → typed error on double-violation/transport failure. The guardrail is a standalone module so it unit-tests without network. Selection persistence uses S-02's check-then-insert/update (no unique-index transaction trap). The frontend is a `client:load` island gating on prerequisites and driving the modifier→skeleton→results→commit flow.

## Phases at a Glance

| Phase                      | What it delivers                                             | Key risk                                                                        |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1. AI core (backend)       | Config + guardrail (+tests) + service + `POST /recommendations` + cap table | Prompt/guardrail quality; @anthropic-ai/sdk on workerd; 10s p95 + 10ms CPU cap |
| 2. Selection persistence   | Workout-selection service + `GET`/`POST /select`            | One-row-per-day upsert correctness                                              |
| 3. Frontend island         | Modifier form + skeleton + results + section + dashboard wiring | Gating/degrade state matrix; ≤3-actions flow                                 |

**Prerequisites:** S-01 (done) + S-02 (done); a funded `ANTHROPIC_API_KEY`; local Supabase + Docker for the migration; verify via `npm run preview` (the `astro dev` React-dedup issue).
**Estimated effort:** ~2–3 sessions across the 3 phases.

## Open Risks & Assumptions

- **Prompt quality is the real risk** — the guardrail catches implausible *loads*, but not a bland or unhelpful explanation; prompt iteration during Phase 1 manual verification is expected.
- The plausible-load band is a heuristic derived from the last 3–4 activities; tune it if it false-positives on legitimate build-up weeks or false-negatives on taper.
- `@anthropic-ai/sdk` must build cleanly under workerd (test in `wrangler dev` before merge, per the infra doc).
- Paid API: the soft cap + Anthropic's own limits bound spend; per-call cost is fractions of a cent at MVP scale.

## Success Criteria (Summary)

- A runner sets modifiers and receives a primary + 2 plausible, goal-and-recovery-aware alternatives within ~10s, then commits one — all from the dashboard, in ≤3 actions.
- No implausible workload ever reaches the runner (the hard-regression guardrail holds).
- Missing prerequisites and AI failures degrade gracefully (CTA / error+Retry), never a fabricated workout.
