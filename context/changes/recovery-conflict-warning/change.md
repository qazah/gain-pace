---
change_id: recovery-conflict-warning
title: Warn when a hard workout is chosen against low recovery
status: planned
created: 2026-07-21
updated: 2026-07-22
archived_at: null
---

## Notes

Roadmap candidate **S-06**. Extends the S-03/S-04/S-05 recommendation loop. Builds directly on S-05 (`workout-step-detail`) — reuses the per-alternative `steps` to detect "hard" options.

**Problem / origin (brainstorming):** Recovery data (sleep score, HRV, body battery) *already* reaches the model server-side — `buildUserContext` (`recommendations.ts`) fetches it via `getDashboardData` and includes it in the prompt (the browser only POSTs the modifiers; recovery is added server-side, which is why it's invisible in the Network tab). The gap is that nothing **deterministically** flags the conflict "recovery is low but the runner asked for a hard session," and there is **no visible warning** for the runner. Real-world case: body battery is low, but the runner deliberately wants a hard workout.

**Guiding principle:** the runner's intent always wins — nothing is blocked/vetoed. The watch **informs**, never gates. Code owns *whether* to warn (deterministic); the model owns *how it's worded*; a static fallback guarantees the signal never silently disappears.

**Locked design decisions (approach A — flag in code + model-authored text):**

1. **Trigger (deterministic, server-side):** `recoveryConflict = recovery-present && body_battery.current < LOW_BODY_BATTERY && modifiers.intensity === "high"`. Threshold `LOW_BODY_BATTERY` is a constant, start **30**, tune during manual verification. Helper lives in `recommendation-guardrail.ts` (framework-free, alongside `deriveEasyPace`). Body battery only drives the flag — sleep/HRV stay as model context (no HRV baseline exists to threshold against).
2. **"Hard option" detection (per-alternative, deterministic):** an option is hard iff any `step.effort ∈ {tempo, threshold, interval}`. Reuses S-05 `steps`.
3. **AI contract:** new per-alternative field `recovery_warning` (string; always present in the JSON schema; Zod `nullish → trim → null`, mirroring `training_arc_note`). Prompt instruction added **only when the flag is set**: for hard options, set `recovery_warning` to one plain sentence (acknowledge pushing despite low recovery + gentle "listen to your body"); leave empty for lighter options.
4. **Guardrail / fallback (code owns "whether"):** after parse — if flag **set**, any *hard* option missing `recovery_warning` gets a static fallback sentence (never lose the safety note); if flag **not set**, force `recovery_warning = null` on all options (model can't over-warn). Net: the warning appears iff `(flag set && option is hard)`.
5. **Persistence:** new flat nullable column `recovery_warning TEXT` on `workout_selections`, threaded 1:1 like `training_arc_note` (migration → `database.ts` → `types.ts` → `saveSelection` → `select.ts` → hook). Committed workout shows the warning on reload (snapshot at commit time).
6. **UI:** amber line with a `TriangleAlert` icon (distinct from the purple `training_arc_note`) under a hard option, in both render sites (`RecommendationResults` card + `RecommendationSection` committed block), shown only when `recovery_warning != null`.

**Accepted nuance:** when the flag is set but the model returns no hard option (it self-softened despite the high-intensity request), no warning shows — there's nothing to attach it to. This is intentional ("warn only genuinely hard options").

**Explicitly NOT doing:** no sleep-score/HRV thresholds; no per-user HRV baseline; no blocking/veto; no changes to the pace/duration guardrails; warning only under hard options and only when the flag is set.

**Open item for planning:** confirm the `LOW_BODY_BATTERY` starting threshold (30) and the exact fallback sentence wording.

Full brainstorm converged via /superpowers:brainstorming on 2026-07-21.
