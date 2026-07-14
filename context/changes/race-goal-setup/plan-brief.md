# Race Goal Setup — Plan Brief

> Full plan: `context/changes/race-goal-setup/plan.md`

## What & Why

Let a logged-in runner define and edit a single long-term race goal — event name, date, distance, target finish time (PRD FR-008 / roadmap S-02). The goal is persisted to the existing `race_goals` table and exposed via an API so the S-03 AI recommendation loop can read it as context. This is the second input into S-03 (alongside S-01's live Garmin data).

## Starting Point

The `race_goals` table, its per-user RLS policies, and the `authenticated` grants are all already applied by F-01 — and `RaceGoal` is exported at `src/types.ts:3`. Nothing reads or writes it yet: there is no service, route, or UI. S-01 has established a clean, copyable vertical-slice pattern (validation → DI service → JSON API route → `client:load` dashboard island) that this slice mirrors.

## Desired End State

On `/dashboard`, a runner with no goal sees a form; after saving they see a read-only summary card (event, date, distance, target, computed pace) with an Edit button that reveals a prefilled form. Editing updates the same row in place. Bad input (past date, out-of-band distance, implausible pace, empty name) is rejected inline and on the server. `GET /api/race-goals` returns the active goal for S-03 to consume later.

## Key Decisions Made

| Decision              | Choice                                              | Why (1 sentence)                                                                 | Source |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| Goal change lifecycle | Edit in place (always UPDATE the one active row)    | Sidesteps the one-active-per-user partial-index transaction gotcha; S-03 only needs the current goal | Plan   |
| Save API shape        | One `POST` create-or-update + `GET` current         | Matches the idempotent single-goal mental model; one client call                 | Plan   |
| Time input            | Three H / M / S number fields → seconds             | Unambiguous, no string parsing, clean map to `target_finish_seconds`             | Plan   |
| Distance input        | Preset chips (5K/10K/Half/Marathon) + custom km     | Fast for the common case, still flexible, nudges valid values                    | Plan   |
| UI placement          | Section on `/dashboard` (GarminSection pattern)     | One daily-context screen; least new routing                                      | Plan   |
| Validation            | Future date + distance band + name + pace sanity    | Roadmap S-02 Risk requires blocking malformed AI context for S-03                | Plan   |
| Empty/saved states    | Form when none; summary card + Edit toggle when set | Mirrors S-01's connect→dashboard state switch                                    | Plan   |
| Delete / expiry       | No delete (edit-only) in MVP; past-date goal shown  | Least code; never silently drops the only AI-context source                      | Plan   |
| Testing bar           | Light — lint + build + manual (no unit tests)       | Low-risk CRUD; deliberately departs from the S-01 `*.test.ts` convention         | Plan   |

## Scope

**In scope:**
- Shared `race-goal-validation.ts` (guardrail constants + pure `validateRaceGoal`)
- `src/lib/services/race-goals.ts` (`getActiveRaceGoal`, `saveRaceGoal`, `RaceGoalError`)
- `src/pages/api/race-goals.ts` (GET current / POST create-or-update)
- `RaceGoalInput` DTO in `src/types.ts`
- Dashboard island: `useRaceGoal` hook, `RaceGoalForm`, `RaceGoalSummary`, `RaceGoalSection` + `dashboard.astro` wiring

**Out of scope:**
- Any migration / schema change (table exists)
- Goal history, multiple goals, delete, goal-expiry logic, onboarding gate
- New automated unit/API/E2E tests
- S-03 AI consumption of the goal

## Architecture / Approach

Two phases, backend then frontend, mirroring S-01. `saveRaceGoal` reads the active row first and INSERTs when none exists, otherwise UPDATEs it in place — so a second active row is never created and the partial unique index never fires (no transaction needed). Validation lives once in a framework-free module: the API route parses shape with `astro/zod` then calls `validateRaceGoal` for semantic guardrails, and the React form calls the same function for inline errors.

## Phases at a Glance

| Phase        | What it delivers                                          | Key risk                                                                 |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1. Backend   | Validation module + service + GET/POST API route          | Edit-in-place must never insert a second active row (partial-index trap) |
| 2. Frontend  | `useRaceGoal` + form + summary + section, wired to dashboard | Client/server validation drift; time & distance conversion correctness |

**Prerequisites:** F-01 (done). Local Supabase running for manual verification.
**Estimated effort:** ~1 session across the 2 phases.

## Open Risks & Assumptions

- Edit-in-place leaves the schema's history capability (inactive rows) unused; a future history feature would need to revisit this and add an atomic deactivate-old + insert-new RPC.
- A goal whose `event_date` has passed keeps displaying unchanged — S-03 must tolerate a past date in its prompt context.
- Pace/distance bands (`[150,900]` s/km, `[1,100]` km) are heuristics; tune the constants if they reject legitimate inputs.

## Success Criteria (Summary)

- A runner can set a race goal and later edit it, seeing an accurate summary with computed pace — all from the dashboard.
- Implausible input is blocked before it can become malformed S-03 context.
- `GET /api/race-goals` exposes the active goal for the next slice.
