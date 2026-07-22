# Low-Recovery Conflict Warning — Plan Brief

> Full plan: `context/changes/recovery-conflict-warning/plan.md`
> Design + locked decisions: `context/changes/recovery-conflict-warning/change.md`

## What & Why

Roadmap slice **S-06**. When a runner asks for a hard session (`intensity = high`) while their body battery is low, show a one-line amber caution under each genuinely hard alternative — acknowledging the tradeoff and nudging them to listen to their body. The runner is never blocked; the watch informs, it does not gate.

## Starting Point

The S-03/S-04/S-05 recommendation loop already feeds recovery data (sleep score, HRV, body battery) to the model server-side, and each alternative already carries structured `steps` (S-05). But nothing *deterministically* flags "low recovery + wants hard," and there is no visible caution for the runner.

## Desired End State

With `intensity=high` and body battery below the threshold, hard options (those with a tempo/threshold/interval step) show an amber caution line — in the results cards and, after commit, in the "Committed" block on reload. Lighter options, normal intensity, healthy battery, or missing recovery → no caution anywhere. The runner can still pick whatever they want.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Signal to trigger on | Body battery only | Sleep/HRV stay model context; HRV has no stored baseline to threshold | Brainstorm |
| Trigger condition | `body_battery < 20 && intensity === "high"` | Runner's own scenario: low battery but wants hard; 20 is conservative | Brainstorm + Plan |
| Block vs inform | Inform only (no veto) | Intent always wins — a caution, never a gate | Brainstorm |
| Who decides warn vs words | Code owns *whether*, model owns *wording*, static fallback backs it | Deterministic + consistent + never silently dropped | Brainstorm |
| Which options warn | Only "hard" ones (tempo/threshold/interval step) | Reuses S-05 steps; a gentle alt shouldn't carry a caution | Brainstorm |
| Persistence | Flat `recovery_warning TEXT` column | 1:1 with `training_arc_note`; only the committed option needs it | Plan |
| Fallback wording | "Your recovery looks low today — this is a demanding session, so listen to your body and ease off if needed." | Acknowledge + gentle, English (matches model prose) | Plan |

## Scope

**In scope:** deterministic flag + hard-option detection (guardrail module); `recovery_warning` field in the AI contract with model-authored text + static fallback; flat column persistence; amber caution line in both render sites.

**Out of scope:** sleep/HRV thresholds; HRV baseline; any blocking/veto; re-prompts on the warning; changes to duration/pace guardrails, daily cap, error taxonomy, modifier form, `training_arc_note`, or S-05 `workout_detail`; new unit tests; a warning when the flag is set but the model returns no hard option.

## Architecture / Approach

Additive to the single Claude call. Server computes `recoveryConflict` from `dashboard.recovery.bodyBattery.current` + `modifiers.intensity`. The JSON schema gains a lenient `recovery_warning` field (nullish→null, like `training_arc_note`); a conditional prompt line is appended only when the flag is set. **After** the plausibility guardrails pass, the mapping step resolves the field: `null` unless `recoveryConflict && isHardWorkout(steps)`, else the model's sentence or a static fallback. It never triggers a re-prompt. Persisted as a flat column and rendered as an amber `TriangleAlert` line.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data model & migration | `recovery_warning` column + DTO field | none material (additive nullable column) |
| 2. AI contract, flag & fallback | schema field + `LOW_BODY_BATTERY`/`isRecoveryConflict`/`isHardWorkout` + mapping/fallback | must run after guardrails, never re-prompt |
| 3. Persistence | write + read the column | mirror `training_arc_note` exactly |
| 4. Render | amber caution line in both sites | keep distinct from purple arc-note line |

**Prerequisites:** S-05 done (reuses `steps`); local Supabase (Docker) for the migration.
**Estimated effort:** ~1–2 sessions across 4 small phases (each ~1 file group; 1:1 with known patterns).

## Open Risks & Assumptions

- **Threshold tuning:** body battery < 20 is conservative — may rarely fire. Easy to adjust the single constant during manual verification.
- **No automated coverage** for `isRecoveryConflict`/`isHardWorkout` (per the testing decision); the existing guardrail tests must stay green.
- **Assumption:** `dashboard.recovery.bodyBattery.current` is populated when recovery is present; when missing, `current` is null → flag stays false (correct).

## Success Criteria (Summary)

- With `intensity=high` + low battery, hard options show the caution; everything else stays clean.
- Committing a hard option persists and re-displays the caution on reload; null cases render nothing.
- No regression to the existing recommendation → select → reload flow; all automated checks + migration pass.
