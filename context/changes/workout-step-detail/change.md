---
change_id: workout-step-detail
title: Structured workout detail per recommendation
status: impl_reviewed
created: 2026-07-21
updated: 2026-07-21
archived_at: null
---

## Notes

Roadmap slice **S-05** (`workout-step-detail`), Stream A. PRD refs FR-004, FR-005 (extends — no dedicated FR yet; consider a PRD addendum). Prereqs **S-03** + **S-04** (both done/archived).

Outcome: for each of the 3 recommended alternatives, the runner sees (a) a one-line summary under the workout name — duration + effort type + target pace (e.g. "45 min easy 6:15/km") — and (b) for structured sessions, an expandable ("show details") step-by-step breakdown with per-segment targets (e.g. 10 min easy 6:00 → 5× [1 min ~4:20 / 2 min easy 7:30] → 10 min easy 6:00).

**Decision locked (brainstorming):** target paces are derived from the runner's recent runs **and validated by a guardrail** for plausibility — the pace analogue of S-03's volume/duration guardrail. Suggesting a pace the runner can't hit is a new hard-regression class.

**Unknowns to resolve in `/10x-plan`:**
- Data model: structured step array (segments) vs a richer free-text detail block.
- Persistence: store the breakdown on `workout_selections` (JSONB column → migration) vs show it only on fresh generation.
- Pace guardrail: how to derive a plausible pace band from recent activities (distance/duration/HR).
- Format/units (min/km) and the expand UI (only for sessions that have steps).

Builds on the S-03/S-04 AI chain: single Claude Haiku structured-output call in `src/lib/services/recommendations.ts`; guardrail in `src/lib/recommendation-guardrail.ts`; render in `RecommendationResults.tsx` + `RecommendationSection.tsx`.
