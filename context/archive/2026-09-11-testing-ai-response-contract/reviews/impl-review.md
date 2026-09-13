<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Test Rollout Phase 1 — AI Response Contract

- **Plan**: `context/changes/testing-ai-response-contract/plan.md`
- **Scope**: Full plan, Phases 1–6 (commits `74ce24c`, `19d1f2d`, `d1d0c30`, `78a83d9`, `6e5580e`, `5869b65`, `bc12b0d`)
- **Date**: 2026-09-13
- **Verdict**: NEEDS ATTENTION
- **Findings**: 1 critical, 6 warnings, 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | WARNING |
| Safety & Quality    | FAIL    |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

**Why NEEDS ATTENTION and not REJECTED.** The rubric maps any critical FAIL to REJECTED. F1 is pre-existing behaviour that this change neither introduced nor worsened — it was found _because_ the rollout put the guardrail under a microscope. Nothing this change shipped is a regression, every automated criterion passes, and the mutation gate ran. Applying REJECTED would misdescribe work that strictly improved the module.

**Success Criteria evidence (re-run at HEAD, 2026-09-13):** `npm test` 41 passed / 3 files · `npm run lint` exit 0 · `npx astro check` 0 errors 0 warnings · `npm run build` complete · `npx stryker run` completes, score 46.60% total / 52.27% covered. Manual rows 3.10, 4.6, 5.4, 5.5, 6.4–6.6 were confirmed by the human in session; rows 1.5, 2.8, 2.9 predate this session and are corroborated by the diff (`RecommendationResults.tsx` notice stacking) but were not independently re-verified.

## Fixed before this report was written

Two findings from the plan-drift pass were corrected at the author's request
before the report was compiled, so they carry no F-number:

- **Cookbook §6.1 described the wrong seams.** It claimed the service reads
  three Supabase tables including `garmin_credentials` via `getDashboardData`.
  After Phase 1 rewired that path to a `SessionStore`, only `race_goals` and
  `recommendation_usage` are read. §6.1 is precisely the artefact §3 Phases 2–4
  copy from, so a stale description there would have propagated. Rewritten to
  name all three seams (fake `SessionStore`, table-aware fake Supabase, stubbed
  `fetch`).
- **`change.md` never recorded the open-question outcomes** Phase 6 required.
  Added: OQ2 resolved by Phase 2 (a lone survivor ships, flagged), OQ3
  knowingly accepted (silent positional re-ranking, no source defines rank
  semantics), plus the question the rollout itself added — `.length(3)` turning
  a two-alternative response into a hard 502.

## Findings

### F1 — Empty activity history silently disables the plausibility guardrail

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/recommendations.ts:283-290, src/lib/recommendation-guardrail.ts:201-203
- **Detail**: `getDashboardData` never throws on sidecar failure — it returns `connected: true, activities: [], stale: true` (`garmin.ts:300-303`). The prerequisite gate checks only `connected`, so generation proceeds with no history. With `activities: []`, `deriveDurationBand` falls back to `[ABS_MIN_MINUTES, ABS_MAX_MINUTES]` = 10–240 min and `deriveEasyPace` returns `null`, dropping the pace band to absolute caps. The guardrail this entire rollout is built around is effectively off exactly when context is missing — against PRD l. 42 (formerly l. 39), which calls hallucinated loads "a hard regression". Phase 1's cookie-mode wiring widens reachability: `CookieSessionStore.saveSnapshot` is a no-op, so cookie-mode runners have no cached snapshot to fall back to. **Pre-existing; not introduced by this change.**
- **Fix A ⭐ Recommended**: Gate on history, not just connection — throw `RecommendationNotReadyError("garmin")` when `dashboard.activities.length === 0`.
  - Strength: Refuses to generate rather than generating unguarded; reuses the not-ready path the UI already renders.
  - Tradeoff: A runner with a genuinely empty history gets no recommendation until a sync lands.
  - Confidence: HIGH — the not-ready branch and its UI already exist and are tested.
  - Blind spot: Have not measured how often `activities` is legitimately empty for a new runner.
- **Fix B**: Keep generating but surface a distinct "unverified load" marker on the result, alongside `degraded`.
  - Strength: Preserves availability; follows the degradation pattern this rollout just established.
  - Tradeoff: Ships a workout the guardrail could not vet — arguably what PRD l. 42 forbids.
  - Confidence: MEDIUM — depends on a product call no source settles.
  - Blind spot: No source states whether an unvetted recommendation beats none.
- **Decision**: PENDING

### F2 — The wall-clock budget bounds attempts, not wall-clock time

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence / Safety & Quality
- **Location**: src/lib/services/recommendations.ts:60, 309, 321-328
- **Detail**: The guard is pre-flight only: `attempt > 1 && now() - started > TOTAL_BUDGET_MS`. It never constrains the attempt it admits. The client is built with `timeout: 20_000, maxRetries: 2`, so one `messages.create` is up to 3 HTTP attempts ≈ 61.5 s including backoff. A run admitted at 44.9 s elapsed therefore exits at ≈ 106 s — better than the ~184.5 s research measured, but not the "stated bound" the phase promised, and roughly 10× the PRD's 10 s p95. Compounding it, `started = now()` is set _after_ the prerequisites, which can add ~40 s of sidecar and Supabase work, pushing the true ceiling to ≈ 145 s — past Cloudflare's ~100 s edge timeout, so the runner sees a generic edge error instead of the crafted "Timed out waiting for your recommendation" message. **This is a plan flaw as much as an implementation one**: the plan specified exactly this mechanism ("checked at the top of the loop body for attempts after the first") and the implementation matches it precisely. The in-code comment claiming the budget "bounds this compounding" overstates what it does. `TOTAL_BUDGET_MS = 45_000` was chosen by the implementer; no source fixes it.
- **Fix A ⭐ Recommended**: Make the budget binding — derive each call's timeout from the remaining budget (`timeout: clamp(TOTAL_BUDGET_MS - elapsed)`, `maxRetries: 0` or `1` in-loop), start the clock at function entry so prerequisites count, and re-check after each attempt as well as before.
  - Strength: The ceiling becomes real, and the friendly timeout message actually reaches the runner instead of Cloudflare's.
  - Tradeoff: Reopens a shipped phase; needs a test that counts HTTP attempts rather than loop attempts.
  - Confidence: HIGH — the SDK accepts per-call `timeout`/`maxRetries`, and the clock seam already exists.
  - Blind spot: Lowering `maxRetries` in-loop may raise the transient-failure rate; unmeasured.
- **Fix B**: Keep the mechanism, fix only the claim — correct the code comment and record in `research.md` that the guard bounds attempt _count_, with the real worst case stated.
  - Strength: Cheap and honest; no behaviour change to re-verify.
  - Tradeoff: Leaves a 106 s worst case against a 10 s p95 target.
  - Confidence: HIGH — documentation-only.
  - Blind spot: None significant.
- **Decision**: PENDING

### F3 — Every failure class exits before the structured log

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/recommendations.ts:327, 346, 348, 358 vs 432
- **Detail**: The structured `console.log` sits at :432. Every `throw new LlmError` inside the loop — budget timeout (:327), connection timeout (:346), transport (:348), refusal (:358) — exits before it. Only the exhaustion throw (:448) is logged, because it sits after. So the failure classes Phase 3 created to make failures diagnosable produce **no log line at all** in `wrangler tail`, and the `inputTokens`/`outputTokens` accumulated for those attempts are discarded — spend that was paid and cannot be seen. This materially undercuts Phase 3's stated purpose.
- **Fix**: Wrap the loop in `try/finally` so the structured log emits on every exit path, throws included.
- **Decision**: PENDING

### F4 — The route was modified despite the plan saying it would not be

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/pages/api/recommendations/index.ts:48-54
- **Detail**: Phase 1's contract states "The route at `src/pages/api/recommendations/index.ts:47` is not modified" and that `deps` is the _fourth_ parameter. In fact `74ce24c` rewired the route to build a cookie-aware store (`CookieSessionStore` / `DbSessionStore`), and `deps` is the _fifth_ parameter because `store: SessionStore` was inserted third. The reason is sound — `generateRecommendation` was calling `getDashboardData(supabase, userId)` against a signature that had taken a `SessionStore` since `71fae14`, so `POST /api/recommendations` was returning 500 in production — and it is disclosed in the commit body and in test-plan §6.6. But a production behaviour change (cookie-only runners now get recommendations at all) rode inside a phase whose plan said it would touch no production call site.
- **Fix**: Add a short addendum to the plan's Phase 1 recording that the route was rewired and why, so the plan stops contradicting the code it describes.
- **Decision**: PENDING

### F5 — Daily cap is non-atomic and counts only successes

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/recommendations.ts:143-160, 292-296, 452
- **Detail**: `readTodayCount` → `bumpTodayCount(current + 1)` is a read-modify-write that upserts an absolute value, so two concurrent submits both read 2 and both write 3 — the cap undercounts. More consequential: the bump happens only on success (:452), so a runner stuck in a failure loop is uncapped, and each failed request can cost `MAX_ATTEMPTS (3) × (maxRetries + 1) (3)` = **9 provider calls**. Outside this rollout's risk set — the 429 path belongs to §3 Phase 2 — but it is a live cost exposure.
- **Fix**: Count attempts rather than successes (or increment before the model call and refund on failure), and make the bump atomic via an `rpc` doing `count = count + 1` against the `user_id,day` unique constraint.
- **Decision**: PENDING

### F6 — `ignoreStatic: true` exempts the safety constants from the mutation gate

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: stryker.conf.json:8
- **Detail**: `ignoreStatic` drops mutants in module-level initializers, silently excluding `TOTAL_BUDGET_MS`, `TIMEOUT_MS`, `MAX_ATTEMPTS`, `MIN_ALTERNATIVES`, `DAILY_CAP`, the whole `SYSTEM_PROMPT`, and the guardrail's `MIN_FACTOR` / `MAX_FACTOR` / `EFFORT_PACE_MULTIPLIERS` / `ABS_*` caps — 17 ignored mutants in `recommendations.ts` alone. The safety constants are exempt from the gate meant to probe them, and the reported score overstates protection. Most of those mutants would be _ignored in triage_ anyway, since the plan forbids pinning the constants — but they should appear in the report and be dismissed deliberately, not be invisible.
- **Fix**: Run one pass with `ignoreStatic: false` over `recommendation-guardrail.ts` and record the verdicts in `mutation-triage.md`; keep the flag on for routine runs.
- **Decision**: FIXED — measured rather than assumed. A pass with `ignoreStatic: false` over `recommendation-guardrail.ts` adds 26 mutants (229 -> 255), of which 11 are killed and 15 survive; the score moves 47.16 % -> 46.67 %. The 15 survivors are the ungrounded constants the plan forbids pinning, so `ignoreStatic: true` is kept for routine runs — now a deliberate, measured choice. Recorded in `mutation-triage.md`.

### F7 — Stryker copies `.env` and `.dev.vars` into its sandbox

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: stryker.conf.json:9-20
- **Detail**: Stryker does not read `.gitignore`; only its own `ALWAYS_IGNORE` list plus the supplied `ignorePatterns` are excluded. Neither covers `.env`, `.dev.vars` or `dist-preview/`, so real Supabase and Garmin secrets are duplicated into `.stryker-tmp` on every run. Separately, the patterns are unanchored globs: `context`, `public`, `dist`, `supabase`, `sidecar` would match a same-named directory at any depth — harmless today, but a future `src/lib/context/` would be dropped from the sandbox and fail as module-not-found for no visible reason.
- **Fix**: Add `/.env*`, `/.dev.vars`, `/dist-preview` to `ignorePatterns` and anchor the existing entries with a leading `/`.
- **Decision**: FIXED — `stryker.conf.json` now excludes `/.env*`, `/.dev.vars` and `/dist-preview`, and every pattern is anchored with a leading `/` so a future same-named directory under `src/` cannot be silently dropped from the sandbox.

### F8 — PRD reflow invalidated every PRD line reference in the repo

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: context/foundation/prd.md (commit 5869b65)
- **Detail**: Running `prettier --write` on the PRD during Phase 6 inserted 12 blank lines, making the commit 17 insertions / 5 deletions rather than the intended 5 / 5. The five amended lines are correct and l. 39 / l. 53 are byte-identical as the plan required — but they now live at **:42** and **:57**. Every "PRD l. NN" citation in `plan.md`, `research.md`, `change.md`, `test-plan.md` and in source comments is now off by 3–6 lines. Those citations are the oracle references this whole rollout is built on.
- **Fix**: Cite PRD sections by heading rather than line number, or sweep the stale numbers once.
- **Decision**: FIXED — 37 stale references swept across 7 files. The mapping (22->22, 33->34, 39->42, 51->55, 53->57, 60->65, 79->88, 90->101, 91->102, 111->123) was derived by locating each cited passage by its text, not by diff arithmetic, because difflib mis-maps the five lines this change itself amended.

### F9 — `reason` reaches the client but nothing consumes it

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/pages/api/recommendations/index.ts:72, src/components/hooks/useRecommendation.ts:76
- **Detail**: The hook reads `json.reason` only on the `not_ready` branch and ignores it for `llm_error`, so the taxonomy is currently a test-and-log surface only. The plan knew this ("the UI does not yet branch on `reason`"), so it is deferred rather than missed — worth naming so it does not quietly stay deferred forever.
- **Fix**: Record it as deferred work for §3 Phase 3 (presentation layer), or wire a per-reason message in the hook.
- **Decision**: PENDING

### F10 — `lastViolations` reflects raw model output into the response body

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/recommendations.ts:448, src/lib/recommendation-guardrail.ts:164
- **Detail**: Risk #8 is tracked for the _provider's_ error text. The same channel carries a second payload: the exhaustion message embeds `parsed.issues`, which is `JSON.stringify(z.treeifyError(...))` and therefore contains fragments of raw model output and internal schema paths. No XSS — React escapes it and the hook does not render it — but it belongs in the same risk entry rather than being discovered separately later.
- **Fix**: Extend the Risk #8 entry in `test-plan.md` §2 to name `lastViolations` alongside the provider message.
- **Decision**: PENDING
