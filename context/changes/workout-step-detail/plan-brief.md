# Structured Workout Detail per Recommendation — Plan Brief

> Full plan: `context/changes/workout-step-detail/plan.md`

## What & Why

Roadmap slice **S-05**. Today an AI recommendation is a label + total duration + two prose lines — it doesn't tell the runner *how* to run the session. This makes each of the 3 options a concrete, runnable prescription: a one-line summary under the name (e.g. "45 min easy 6:15/km") plus, for structured sessions, an expandable step-by-step breakdown with per-segment effort, duration, and target pace — with paces grounded in the runner's recent runs and validated by a guardrail.

## Starting Point

Extends the S-03/S-04 single Claude-Haiku call. Each alternative already carries `workout_type`, `duration_minutes`, `ai_explanation`, `training_arc_note`; the guardrail validates only total duration and re-prompts-then-fails on violation; the model already receives per-activity distance+duration (→ implied pace). Persistence is flat columns on `workout_selections` (JSONB precedent: `garmin_data_snapshot`); render is two React islands.

## Desired End State

Generating recommendations shows a summary line per option and, when the session has >1 segment, a "show details" toggle revealing an ordered step list (effort · duration · pace). The committed block shows the same on reload. Every shown pace has passed the plausibility guardrail; an implausible pace is never shipped. Older selections (null detail) render cleanly.

## Key Decisions Made

| Decision                    | Choice                                                        | Why (1 sentence)                                                        | Source |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| Pace treatment              | Grounded in recent runs + guardrail                           | Pace analogue of S-03's volume hard-regression; wedge is "your data"   | Brainstorm |
| Data model                  | Structured steps array (typed segments)                       | A pace in free text can't be guardrailed; enables the expand UI        | Plan   |
| Persistence                 | New nullable JSONB `workout_detail = {summary, steps}` (migration) | Runner reloads to run the workout; consistent with other persisted AI fields | Plan   |
| Pace band                   | Easy-pace anchor from recent runs × per-effort multipliers    | Grounds to the runner while allowing legitimately faster intervals     | Plan   |
| Bad-pace handling           | Re-prompt once, then typed error (like the duration guardrail) | Never ship an implausible pace — matches the S-03 defense              | Plan   |
| Segment units               | Time-based only (MVP)                                          | Matches the user's examples; keeps the duration invariant simple       | Plan   |
| Summary                     | Separate model-authored `summary` field (+ steps)             | Model controls phrasing; simple runs read as summary-only              | Plan   |
| `steps` cardinality         | Always ≥1 (single-step for plain runs; toggle only when >1)   | Every pace lives in a guarded step; UX still "summary-only" for easy runs | Plan (refinement) |
| Testing                     | Manual only; keep existing guardrail tests green              | User's call — flagged as a risk for a new safety guardrail             | Plan   |

## Scope

**In scope:** JSONB column + migration + DB/DTO types; `summary` + `steps` in the AI schema/Zod; pace-band derivation + per-step + duration-sum guardrail wired into the re-prompt loop; prompt update; persistence (service + select API); summary line + expandable steps in both render sites.

**Out of scope:** distance-based segments; nested repeat groups; `.fit` export; VDOT/critical-speed pace math; changes to the duration guardrail / daily cap / modifier form; new unit tests.

## Architecture / Approach

Database-change order: migration/types → AI contract + guardrail → persistence → UI. One call, two new fields (`summary`, `steps`). `WorkoutStep = {effort, duration_minutes, target_pace}`; pace is `"m:ss"`/km in the model output, parsed to seconds for the guardrail, shown verbatim. The pace guardrail computes the runner's easy pace from recent runs, bands each step by effort, checks the durations sum to the total, and re-prompts-then-fails on violation — same discipline as the existing duration guardrail. Persisted as one JSONB column.

## Phases at a Glance

| Phase                          | What it delivers                                          | Key risk                                                   |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Data model & migration      | Nullable JSONB column + DB/DTO types                     | Local Supabase/Docker needed to apply the migration        |
| 2. AI contract + pace guardrail| Model emits summary + steps; paces grounded & guarded    | Pace-band heuristic tuning; new guardrail has no unit test |
| 3. Persistence                 | Commit stores + reload reads `workout_detail`            | JSON ↔ typed cast correctness                              |
| 4. Render                      | Summary line + expandable steps in both sites            | Expand state; clean null/back-compat render                |

**Prerequisites:** S-03 + S-04 (done); a funded `ANTHROPIC_API_KEY`; local Supabase (Docker) for the migration; verify via `npm run preview`.
**Estimated effort:** ~2–3 sessions across 4 phases.

## Open Risks & Assumptions

- **Prompt/pace quality is the real risk.** The guardrail catches out-of-band paces, but the easy-anchor + effort-multiplier bands are heuristics — expect tuning during Phase 2 manual verification (false positives on build-up weeks, false negatives on taper).
- **The new pace guardrail ships without automated regression coverage** (manual-only testing). Given it's safety-critical logic (the pace analogue of the volume hard-regression), a later unit-test pass is advisable.
- Assumes recent runs carry usable distance+duration to anchor easy pace; when they don't, the band falls back to absolute caps (looser) — logged.
- `MAX_TOKENS` (2048) is assumed sufficient for multi-step output; raise if truncation appears.

## Success Criteria (Summary)

- Each option shows a concrete summary and, for structured sessions, an expandable step list with realistic per-segment paces that sum to the total.
- No implausible pace ever reaches the runner (re-prompt → error).
- Commit persists the breakdown; reload shows it; older selections render cleanly; `test`/`lint`/`build` pass and the migration applies.
