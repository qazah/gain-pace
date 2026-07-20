# Training Arc Context per AI Recommendation — Plan Brief

> Full plan: `context/changes/training-arc-context/plan.md`

## What & Why

Roadmap slice **S-04** (PRD FR-006), the final piece of the north-star loop. S-03 gives a runner three plausible workout options for *today*; S-04 adds a one-line **training-arc note** to each — how that choice affects their *long-term* progress toward their race goal. It's the "not just what to do, but why it matters in context of recent load and upcoming targets" the PRD calls for.

## Starting Point

S-03 was built with S-04 in mind, so the persistence path is already reserved: the `training_arc_note` field exists on the DTO (`src/types.ts:37`), the nullable DB column exists (`workout_selections.training_arc_note`), and the service already emits the field — hardcoded to `null` (`recommendations.ts:238`). What's missing is (1) actually asking the model for the note, and (2) rendering it.

## Desired End State

Generating recommendations shows, under each of the 3 alternatives, a distinct labeled line describing the long-term arc impact — clearly separate from the existing today's-fit explanation. The returning-user "Committed" block shows the same note. Missing notes (model omission, or older S-03 selections) degrade gracefully: the workout still shows, just without the arc line.

## Key Decisions Made

| Decision                     | Choice                                                     | Why (1 sentence)                                                              | Source |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Note content / distinctness  | Consequence-of-choice per option (what you gain vs trade toward the goal), distinct across the 3; `ai_explanation` re-scoped to today's fit | Each note reads as a real choice showing its benefit; no redundancy with the today's-fit line | Plan (reframed during manual testing) |
| Missing note from model      | Required in schema, nullable in Zod (empty/absent→null) → graceful degrade | A cosmetic sentence must never fail a valid, plausible workout               | Plan   |
| Display treatment            | Distinct labeled line with icon, both render sites         | Reinforces the today-vs-arc split; scannable; fits existing card style        | Plan   |
| Testing depth                | Manual + keep existing guardrail test green; no new tests  | LOW slice; S-03 deferred the mocked-LLM/eval harness                          | Plan   |
| DB migration                 | None                                                        | The nullable column already exists from S-03                                 | Research |

## Scope

**In scope:** add `training_arc_note` to the structured-output schema (in `required`) + Zod parse (nullable, empty→null); rewrite the system prompt to split today's-fit vs long-term arc; map the parsed value in the service; render a labeled arc line in `RecommendationResults.tsx` and `RecommendationSection.tsx` (null → nothing).

**Out of scope:** DB migration; new unit tests / LLM eval harness; changes to the plausible-load guardrail, API routes, daily cap, or selection persistence logic; backfilling arc notes onto old rows; any separate arc timeline/visualization.

## Architecture / Approach

Single Claude call, unchanged in shape — one added output field. Backend first: schema `properties` + `required` (model reliably emits it) + lenient Zod (graceful degrade: empty/absent → null) + a prompt that assigns `ai_explanation` to *today* and `training_arc_note` to *the arc*, then the service stops hardcoding `null`. Frontend second: a distinct labeled line (lucide icon + muted text) in the two existing render sites, conditional on a non-null note. Persistence and API response already carry the field.

## Phases at a Glance

| Phase                          | What it delivers                                                     | Key risk                                                         |
| ------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. AI contract & service       | Model emits a trajectory note per alternative; service carries it   | Prompt quality — note must be distinct from `ai_explanation`, not a restatement |
| 2. Display                     | Labeled arc line in the 3 cards + the committed block               | Clean null/back-compat rendering (no empty label for old rows)  |

**Prerequisites:** S-03 (done/archived); a funded `ANTHROPIC_API_KEY`; verify islands via `npm run preview` (not `npm run dev`).
**Estimated effort:** ~1 short session across the 2 phases.

## Open Risks & Assumptions

- **Prompt quality is the only real risk** — the structural change is trivial, but the note must genuinely differ from the today's-fit explanation; expect prompt iteration during Phase 1 manual verification.
- With graceful-degrade + manual-only testing, the new field's schema/parse contract has **no automated regression guard** — an accepted trade for a LOW slice.
- The field is in the schema's `required`, so the model emits it reliably; graceful degrade lives in the lenient Zod parse (empty/absent → null). If notes come back blank too often, tighten the prompt rather than the schema.

## Success Criteria (Summary)

- Each alternative shows a distinct, long-term-trajectory arc note alongside its today's-fit explanation, in both the cards and the committed block.
- A missing note never fails or degrades the recommendation — the workout still shows.
- No regression to the S-03 modifier → recommend → commit loop; `test`/`lint`/`build` pass.
