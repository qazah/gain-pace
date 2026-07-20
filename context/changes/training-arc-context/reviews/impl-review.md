<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Training Arc Context per AI Recommendation (S-04)

- **Plan**: context/changes/training-arc-context/plan.md
- **Scope**: Full plan (Phases 1–2 of 2)
- **Date**: 2026-07-21
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

All 5 planned changes MATCH; no scope creep, no missing items. Automated criteria green (test 21/21, lint, build); manual confirmed. Both mid-flight adaptations (field-in-`required` + lenient Zod; the consequence-of-choice prompt reframe) are faithful to the plan's decisions, not drift.

## Findings

### F1 — Plan record contradicts the implemented schema approach

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: plan.md (Critical Implementation Details) + plan-brief.md:29 vs. recommendation-guardrail.ts:31
- **Detail**: The plan text said keep `training_arc_note` OUT of the JSON-schema `required` array (graceful degrade at the schema level). The code puts it IN `required` and enforces graceful degrade in the lenient Zod parse (nullish + empty→null) instead. Functionally equivalent — arguably safer — but the archived plan misdescribed the code.
- **Fix**: Reconcile the plan's Critical Implementation Details, Approach, Key Discoveries, Phase 1 contract, and the plan-brief decision/scope/approach/risk lines to state the chosen approach (field in `required` so the model reliably emits it; graceful degrade in the lenient Zod parse). Also updated the arc-note content wording from the original "long-term trajectory only" to the reframed "consequence-of-choice" framing that shipped.
- **Decision**: FIXED

### F2 — Arc-note line JSX duplicated across the two render sites

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: RecommendationResults.tsx:47-50 & RecommendationSection.tsx:115-118
- **Detail**: The `TrendingUp` icon + muted `<span>` block is duplicated across the two components. Consistent with existing codebase duplication (`formatDuration` is already copied across both files pre-change), so not a regression.
- **Fix**: None recommended — extracting a 4-line presentational snippet isn't worth the indirection for a 4-file diff.
- **Decision**: SKIPPED

### Out-of-scope note (no action)

`select.ts:20` validates the note with `.nullable()` while the guardrail uses `.nullish()`. Intentional and correct — the DTO always carries the field on the client→API hop. `select.ts` was not touched by this change.
