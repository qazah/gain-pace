---
change_id: testing-ai-response-contract
title: Test rollout Phase 1 — AI response contract
status: impl_reviewed
created: 2026-09-11
updated: 2026-09-13
archived_at: null
---

## Notes

Rollout Phase 1 of `context/foundation/test-plan.md` §3. Opened directly by `/10x-research` (the `/10x-new` step was folded in).

**Goal (§3):** the runner gets three valid options or a readable error — never an implausible option, never a silent blank.

**Risks covered (§2):**

- **#1** — a prompt or response-schema change breaks parsing, so instead of 3 options the runner gets an error or an empty screen. (Impact High × Likelihood High.)
- **#2** — an implausible workout option reaches the runner, or one bad option dead-ends the whole request. (High × High.)
- **#7** — an AI call error or timeout ends in an endless spinner or a silent blank instead of a readable error state. (Medium × High.)

**Test types planned (§3):** unit + hermetic (stubbed model client). Zero infrastructure — this phase starts no database and no sidecar.

**Scope boundary (decided 2026-09-11, before research):** assertions stop at the **service / API-endpoint layer**. React islands and rendered output are out of scope — the current Vitest config is `environment: "node"` with `include: ["src/**/*.test.ts"]`, so a UI-level assertion would require an environment sub-phase before any contract test. The presentation half of the seam belongs to §3 Phase 3, which already touches that layer.

**Oracle sources (must NOT come from the implementation):**

- PRD l. 42 — "AI must not recommend unsafe workloads... Hallucinated loads are a hard regression."
- PRD l. 57 — "AI must not recommend a volume or intensity that is implausible given the runner's last 3–4 logged activities."
- PRD l. 55 — each option carries at minimum workout type, estimated duration, and a one-sentence explanation referencing recovery state or goal proximity.
- PRD l. 101 — any operation over 2 s must show continuous visible progress; the runner must never wait in silence.

**Anti-patterns named up front (§2 Risk Response Guidance):** implementation mirror (assertion computing the expected shape with the parser's own logic); an oracle copied from the implementation instead of from PRD l. 42; testing only the "everything in band" path; asserting on elapsed time instead of on state.

**Negative space binding this phase (§7):** no UI snapshots, no e2e through a real Garmin account, no model-based tests (LLM-as-judge) — token cost.

## Open questions at close (2026-09-13)

`research.md` §"Still open" is left as the snapshot of what was known on
2026-09-11. Their outcomes:

- **OQ2 — should the single-survivor case discard a valid workout?**
  **Resolved by Phase 2.** `MIN_ALTERNATIVES` is now 1: a lone alternative that
  clears both guardrails ships, flagged as a reduced set, instead of 502-ing the
  request. PRD l. 42 forbids shipping an implausible load; it does not ask us to
  withhold a plausible one. Held by a test ("offers a lone surviving option
  rather than discarding it").
- **OQ3 — is silent positional re-ranking acceptable?**
  **Knowingly accepted, not overlooked.** When the model's best-fit option is
  the one rejected, its second choice becomes `primary` with no trace. No source
  specifies the ranking semantics, so there is nothing to assert against;
  recorded in a source comment at `src/lib/services/recommendations.ts` (the
  salvage block). Revisit only if a source ever defines what a rank means.

One question the rollout _added_, for the next `/10x-test-plan --refresh`: the
response schema pins `.length(3)`, so a model returning two well-formed
alternatives is a hard 502 — the salvage path never sees it, because salvage
runs only after a successful parse. Observed live on 2026-09-13. This sits
awkwardly beside OQ2's resolution and no source settles whether the schema
should accept 1–3 and let the guardrails decide.
