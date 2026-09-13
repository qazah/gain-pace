# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-09-11

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the
   risk wins. Do not promote to e2e because e2e "feels safer." Do not put a
   vision model on top of a deterministic visual diff that already catches
   the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team
   is worried about X, and the failure would surface somewhere in
   `<area>`" carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents _what
   could fail_ and _why we believe it's likely_ — drawn from documents,
   interview, and codebase _signal_ (churn, structure, test base). It does
   NOT claim to know which line owns the failure. That knowledge is
   produced by `/10x-research` during each rollout phase. If the plan and
   research disagree about where the failure lives, research is the
   ground truth.

Hot-spot scope used for likelihood weighting: `src`, `sidecar/src`,
`supabase/migrations`. **Widened window** — the standard 30-day window is
empty (last commit 2026-07-23), so churn is counted over the repository's
full history (2026-05-24 → 2026-07-23, 59 commits). This churn reflects the
build-out phase, not current activity.

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by
risk = impact × likelihood. Risks are failure scenarios in user / business
terms, not test names. The Source column cites the _evidence that surfaced
this risk_ — never a specific file as "where the failure lives" (that is
research's job, see §1 principle #3).

| #   | Risk (failure scenario)                                                                                                                                                                                  | Impact | Likelihood | Source (evidence — not anchor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A change to one of the response-contract layers desynchronises them — a renamed or added field is silently dropped, or shape drift exhausts every retry and the runner gets nothing                      | High   | High       | interview Q3; hot-spot dir `src/lib/services` (23 commits, top dir), `src/lib` (15); PRD l. 79–86 (FR-005/FR-006 — the product's core); research 2026-09-11 — the contract is spread across four layers with no single source of truth, and unknown fields are stripped without a signal                                                                                                                                                                                                                                     |
| 2   | The degradation contract changes silently — the salvage path that ships a reduced set of alternatives is pinned by no test and contradicts every written source, so a revert or re-tune passes unnoticed | High   | High       | PRD l. 39 ("hallucinated loads are a hard regression"), l. 53 (US-01 acceptance criteria); archive `2026-07-14-modifier-to-recommendation-loop/plan.md` — records the opposite contract ("a double-violation is a failure, not a fabrication"); git history — the fix in this seam shipped with no test file touched (commit `d4cad20`); hot-spot dir `src/lib` (15)                                                                                                                                                         |
| 3   | A stale Garmin snapshot is presented to the runner as live data                                                                                                                                          | High   | High       | interview Q1; roadmap l. 93 (graceful degradation + last-good snapshot cache); PRD l. 22 (the wedge is grounding in the runner's real data); hot-spot dir `src/components/garmin` (10), `src/lib/services` (23); test-base profile — service layer covered, presentation layer has zero tests                                                                                                                                                                                                                                |
| 4   | An API endpoint accepts garbage or unexpected input instead of rejecting it — it reaches the prompt or ends in a 500                                                                                     | Medium | High       | interview Q4; CLAUDE.md ("API routes: validate input with Zod"); hot-spot dir `src/pages/api/garmin` (11), `src/pages/api/recommendations` (4), `src/pages/api/auth` (4); test-base profile — zero tests in those directories                                                                                                                                                                                                                                                                                                |
| 5   | **[abuse — authorization]** One runner's data is readable or writable by another: RLS misconfigured, or an endpoint checks authentication instead of ownership                                           | High   | Medium     | roadmap l. 77 ("credentials or workout selections could leak across users — a hard regression"); PRD l. 111 (Access Control); CLAUDE.md (RLS mandatory, per-operation and per-role policies); hot-spot dir `supabase/migrations` (7)                                                                                                                                                                                                                                                                                         |
| 6   | **[abuse — secret leakage]** Garmin credentials survive a disconnect, or get written in a mode declared as cookie-only                                                                                   | High   | Medium     | PRD l. 91 ("credentials leave no trace"); roadmap l. 165 (the S-07 contract), l. 180 (risk of regressing the default stored-mode path while re-routing session sourcing); git history — three commits of this feature on the current branch                                                                                                                                                                                                                                                                                  |
| 7   | A failing or slow AI call leaves the runner waiting far beyond the stated budget — two retry layers compound with no overall deadline — and every error path is untested                                 | High   | High       | interview Q2 ("problems with AI response time, and there were errors"); PRD l. 90 (NFR: 10 s p95, any operation over 2 s must show continuous visible progress, "never wait in silence"); research 2026-09-11 — worst case bounded at roughly one to four minutes, and no test exercises any error or timeout branch                                                                                                                                                                                                         |
| 8   | **[abuse — information disclosure]** Upstream provider error text is echoed verbatim into the API response body, sending uncontrolled third-party payload to the client                                  | Medium | Medium     | research 2026-09-11 — the generic catch interpolates the SDK error message, which the SDK itself builds from the provider's raw error JSON; PRD l. 111 (Access Control); **live repro 2026-09-13** against `d1d0c30` in preview — an invalid `ANTHROPIC_API_KEY` put the provider's raw error JSON (`401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`) verbatim on the runner's screen, via the transport branch at `src/lib/services/recommendations.ts:317` |

**Impact × Likelihood rubric.** Coarse scale by design — the goal is a
reproducible ordering, not false precision.

| Rating | Impact                                                                                | Likelihood                                              |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| High   | the runner loses access, data, or trust in the recommendation; the failure is visible | area changes often, or we have already been burned here |
| Medium | the feature degrades, a workaround exists, only some paths affected                   | touched occasionally, has been a source of bugs         |
| Low    | cosmetic, easily reverted, no data effect                                             | stable code, rarely touched                             |

The 10 s p95 budget from PRD l. 90 is a **metric, not a test** — it belongs
to observability. Risk #7 covers the part that a test can actually verify
(a readable error state in finite time), not the response time itself.

### Risk Response Guidance

| Risk | What would prove protection                                                                                                                                                   | Must challenge                                                                                                                                                                                                                           | Context `/10x-research` must ground                                                                                                                                                                                                         | Likely cheapest layer                                      | Anti-pattern to avoid                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1   | An unknown or renamed field is not swallowed in silence, and shape drift that exhausts every retry surfaces a diagnosable failure rather than a generic one                   | "The parser works because the happy path passes" — grounded 2026-09-11: shape failures are all-or-nothing, so the danger is not a half-parsed card but a silent strip and an undiagnosable exhaustion                                    | **Grounded:** four contract layers (generation schema, validation schema, prompt prose, plausibility rule) with no single source of truth; unknown fields are dropped without error; a truncated response is indistinguishable from garbage | hermetic (stubbed model client)                            | **Implementation mirror** — an assertion that computes the expected shape with the same logic as the parser; the oracle must come from the product contract, not from the parser's code |
| #2   | A reduced set of alternatives still reaches the runner rather than dead-ending the request, **and** the reduction is visible in the response rather than only in a server log | "The guardrail has tests, so the seam is protected too" — grounded 2026-09-11: the rule is well covered, the salvage seam has zero tests and reverses a recorded design decision                                                         | **Grounded:** the salvage ships survivors re-ranked positionally; the reduction reaches no client-facing field; **contract decided 2026-09-11** — degradation stays but must be signalled, so the oracle for this path is now settled       | hermetic (stubbed model client)                            | Pinning the bare threshold constants (they are ungrounded magic numbers); assert against PRD l. 39's own worked example instead, which survives any retuning                            |
| #3   | When the Garmin data source fails, the runner **sees** that the data is stale — the marker reaches the layer they are actually looking at                                     | "The service returns a staleness marker, so the runner will see it" — these are two different layers and only one has tests today                                                                                                        | External boundary (the sidecar), persisted state (the snapshot), the path the staleness marker travels from service to presentation                                                                                                         | hermetic (stubbed sidecar) + a presentation-layer test     | Treating a service-layer test as coverage of the risk — that is half the seam                                                                                                           |
| #4   | A garbage or incomplete payload ends in a contractual error code; it does not reach the prompt and does not cause a 500                                                       | "Zod is in the code, so validation works" — the schema may be permissive, or bypassed on some paths                                                                                                                                      | Each endpoint's entry point, the error-response contract, whether validation precedes expensive operations                                                                                                                                  | hermetic (request→response contract)                       | Happy path only; six near-identical tests instead of one parameterised test per property                                                                                                |
| #5   | An authenticated request from runner A neither returns nor modifies runner B's row — including when the resource id is supplied directly                                      | "Logged in equals authorised" — authentication is not authorisation                                                                                                                                                                      | Session and identity shape, per-operation and per-role policies on every domain table, the `authenticated` role's grants, whether the endpoint checks ownership independently of RLS                                                        | **integration against a real database**                    | **A stubbed database lies about RLS and cascades** — a mock will pass a query that a real policy rejects                                                                                |
| #6   | After a disconnect no credential row and no snapshot remain; in cookie-only mode no server-side row is ever created                                                           | "Cookie-only mode works, so the default mode does too" — roadmap l. 180 points at exactly the opposite direction of regression                                                                                                           | Persisted state before and after a disconnect, the session source in both modes, exactly what the deletion covers                                                                                                                           | integration against a real database (persisted state)      | Asserting "the delete function was called" instead of "the row is gone"; testing only the new mode and skipping the default one                                                         |
| #7   | Each failure class — timeout, transport error, refusal, retry exhaustion — maps to its own diagnosable outcome, and the request cannot outlive a stated bound                 | "The final status is 200, so the error path works", and "this is a performance problem, so it can't be tested" — grounded 2026-09-11: every failure class currently collapses into one generic response, and no test touches any of them | **Grounded:** two independent retry layers multiply; no top-level deadline wraps the request; a non-recommendation can return as HTTP 200 on two separate paths                                                                             | hermetic (stub returning error/timeout)                    | Trying to test the p95 budget instead of the behaviour; a test that measures elapsed time instead of asserting on state or on the bound                                                 |
| #8   | An upstream failure surfaces a message this application chose, not whatever payload the provider happened to return                                                           | "It is only an error string, nobody reads it" — it is uncontrolled third-party content crossing a trust boundary into a client response                                                                                                  | **Grounded:** the SDK composes its error message from the provider's raw error JSON, and that message is interpolated into the response body unchanged                                                                                      | hermetic (stub returning a hostile provider error payload) | Asserting the exact current message text (that pins a string, not a boundary); assert that provider-supplied content does not appear verbatim                                           |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder
via `/10x-new`. Status moves left-to-right through the values below; the
orchestrator updates Status as artifacts appear on disk.

| #   | Phase name              | Goal (one line)                                                                                                                       | Risks covered       | Test types                                      | Status      | Change folder                                   |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- | ----------- | ----------------------------------------------- |
| 1   | AI response contract    | The runner gets three valid options or a readable error — never an implausible option, never a silent blank                           | #1, #2, #7          | unit + hermetic (stubbed model client)          | shipped     | `context/changes/testing-ai-response-contract/` |
| 2   | API endpoint contract   | Garbage input bounces off validation with a contractual code, never reaching the prompt or a 500                                      | #4, #7 (partial)    | hermetic (request→response contract)            | not started | —                                               |
| 3   | Garmin degradation      | When the data source is unavailable the runner sees a staleness marker; re-routing the session source does not break the default mode | #3, #6 (regression) | hermetic (stubbed sidecar) + presentation layer | not started | —                                               |
| 4   | Data access and privacy | Another runner's row is neither readable nor writable; a disconnect leaves no trace                                                   | #5, #6              | integration against a real local Supabase       | not started | —                                               |

Ordering follows cost × signal: phases 1–3 need no infrastructure, phase 4
needs Docker and a local Supabase, so it goes last. Phase 4 cannot drop to a
cheaper layer — a stubbed database would lie about RLS (§2, response to #5).

The rollout deliberately has **no "AI-native layer" phase**, even though the
template suggests one — see §7.

## 4. Stack

The classic test base for this project. Recommendations are grounded in
local manifests and configuration plus the tools actually exposed in the
current session.

| Layer                | Tool                         | Version                | Notes                                                                                                                   |
| -------------------- | ---------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| unit + integration   | Vitest                       | 3.2.7                  | Configured; `node` environment, scope `src/**/*.test.ts`; the Astro virtual env module is aliased to a test stub        |
| HTTP mocking         | none — hand-stubbed `fetch`  | —                      | No dedicated library (MSW or equivalent). Whether to introduce one or stay with hand-rolled stubs is a Phase 2 decision |
| integration database | Supabase CLI (local, Docker) | 2.23.4 (devDependency) | Not yet used by any test — see §3 Phase 4                                                                               |
| e2e                  | none — deliberate            | —                      | Excluded in §7                                                                                                          |
| accessibility        | none                         | —                      | Out of scope for this rollout                                                                                           |
| mutation testing     | Stryker — not installed      | —                      | Candidate for a **selective** gate after Phase 1; scope narrowed to the changed module, never a per-commit gate         |
| AI-native            | none — deliberate            | —                      | Excluded in §7 (token cost)                                                                                             |

Test-base profile as of 2026-09-11: **sparse** — Vitest configured, two
hand-written test files (roughly 25 tests), both clustered in `src/lib`. API
endpoint directories, middleware, migrations, React islands, and the sidecar
have no tests at all.

**Stack grounding tools (current session):**

- Docs: no dedicated docs MCP (Context7 not available in current session) — the local `supabase:supabase` and `supabase:supabase-postgres-best-practices` skills are available instead as the rule source for Phase 4; checked: 2026-09-11
- Search: Exa MCP available (`web_search_exa`, `web_fetch_exa`) — not used at this stage; tool versions were read from `package.json`, not from the network; checked: 2026-09-11
- Runtime/browser: no Playwright MCP; a Chrome automation skill is available but **unused**, because e2e is excluded in §7; checked: 2026-09-11
- Provider/platform: Supabase and Linear MCPs are present but **unauthenticated** in this session; no GitHub or Cloudflare MCP. Phase 4 is planned against the local Supabase CLI, not against an MCP; checked: 2026-09-11

## 5. Quality Gates

"Required after §3 Phase N" means the gate is enforced once that rollout
phase lands; before that, the gate is planned.

| Gate                                | Where                | Required?                                                                                                             | Catches                                                                                                                |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| lint + typecheck                    | local + CI           | required (wired)                                                                                                      | syntactic and type drift                                                                                               |
| build                               | CI                   | required (wired)                                                                                                      | SSR compilation failures                                                                                               |
| unit + hermetic                     | local + CI           | required (wired — `npm test` is the last step of the CI job); scope grows after §3 Phases 1–3                         | regressions in logic, response contract, and input validation                                                          |
| pre-commit (lint-staged)            | local                | required (wired)                                                                                                      | style and lint before a commit                                                                                         |
| integration against a real database | local, **ad hoc**    | recommended after §3 Phase 4 — deliberately **not** per-commit, because standing up local infrastructure is expensive | RLS violations, ownership breaches, and leftovers after deletion                                                       |
| mutation testing (Stryker)          | local, **selective** | optional after §3 Phase 1                                                                                             | assertions that pass despite broken logic; run on a narrow scope after a risk phase, never as a chase for a 100% score |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the
relevant rollout phase ships.

### 6.1 Testing the AI response contract

Shipped by `context/changes/testing-ai-response-contract/` (commits `74ce24c`,
`19d1f2d`, `d1d0c30`, `78a83d9`, `6e5580e`). Reference implementation:
`src/lib/services/recommendations.test.ts` + `src/test/recommendation-env.ts`.

**Inject the dependency; do not mock the module.** `generateRecommendation`
takes an optional `RecommendationDeps` with `client` and `now`. Production
passes nothing and constructs exactly what it did before.

- _Why not `vi.mock` on the SDK?_ It couples every test to the SDK's module
  shape, and a version bump breaks tests that have nothing to do with the bump.
- _Why not the `fetch` idiom from `garmin.test.ts`?_ The client is built with
  `maxRetries: 2`, so a transport failure stubbed at the fetch layer pays the
  SDK's full retry budget on **every** failure case. Injection makes a failure
  case cost milliseconds.
- The seam type is the structural slice actually used (`Pick<Anthropic,
"messages">`), so the real client satisfies it with no cast and a stub needs
  only `messages.create`.

**The fake Supabase must branch on table name.** The service reads three tables
before it ever calls the model — `garmin_credentials` (via `getDashboardData`),
`race_goals`, `recommendation_usage` — and it also needs global `fetch` stubbed
for the sidecar. The single-canned-row fake in `garmin.test.ts:19-36` will not
serve. Getting this wrong surfaces as `RecommendationNotReadyError` instead of
the behaviour you meant to test, which reads like a bug in the code under test.
Use `makeRecommendationEnv()` rather than rebuilding it.

**Assert the reason code, never the message prose.** Failures carry a typed
`reason` (`timeout` / `transport` / `refusal` / `truncated` / `invalid_shape` /
`implausible`); the human-readable `message` is free to change. Phase 5's
mutation run confirms the split works: mutating `"timeout"` to `""` kills a
test, mutating the prose does not — by design.

**Assert a bound behaviourally, never by elapsed time.** The wall-clock budget
is tested by injecting a clock that jumps, then asserting _how many attempts
were opened_ and which reason came back. No test measures duration and no test
names `TOTAL_BUDGET_MS`. A timing assertion tests the machine it runs on.

**Never pin an ungrounded constant.** `MIN_FACTOR`, `MAX_FACTOR`, the pace
multipliers, `LOW_BODY_BATTERY`, `DAILY_CAP`, `MAX_ATTEMPTS`,
`TOTAL_BUDGET_MS` — research found every one of them unsourced. Assert against
the PRD's own worked example instead (l. 39: a ~180-minute option for a runner
whose recent sessions are ~40 minutes), so the test survives retuning. This is
also why the mutation score sits near 50 % and that is accepted — see
`mutation-triage.md` in the change folder.

**Reference assertion style:** `src/lib/recommendation-guardrail.test.ts:28-32`
states expected values as independent literals with the derivation in a
comment. Do **not** follow `:34-41` in the same file — it imports the constants
from the module under test, so changing them in the source leaves the
assertions passing. That is an implementation mirror, the one pattern this
rollout exists to avoid.

**What the model is asked for is part of the contract.** Assert that the
request carries the JSON-schema `output_config`; without it the model may answer
in prose and every attempt fails the parse. This was unguarded until Phase 5.

### 6.2 Testing an API endpoint

- TBD — see §3 Phase 2. The pattern must cover rejection of garbage input
  with a contractual error code, before any expensive operation runs (#4).

### 6.3 Testing degradation of an external source

- TBD — see §3 Phase 3. The pattern must cover the path a staleness marker
  travels from the service to the layer the runner actually looks at (#3).

### 6.4 Testing data access against a real database

- TBD — see §3 Phase 4. The pattern must cover invisibility of another
  runner's row (#5) and the absence of leftovers after a disconnect (#6),
  including `authenticated` role grants for new tables.

### 6.5 Running tests locally

- Whole suite: `npm test`.
- Configuration: `vitest.config.ts` (`node` environment, scope
  `src/**/*.test.ts`).
- Existing reference tests: `src/lib/recommendation-guardrail.test.ts`
  (rule + parsing), `src/lib/services/garmin.test.ts` (service with a
  stubbed sidecar).

### 6.6 Per-rollout-phase notes

(After each phase lands, two or three lines are appended here capturing
anything surprising the phase revealed.)

**Phase 1 — AI response contract (2026-09-13).** Three of the module's
contracts were not merely untested but wrong against the PRD, so writing tests
that pinned the existing behaviour would have locked in the defects; the phase
fixed the contracts first and pinned them after. `npx astro check` is not in
CI, and `lint` + `build` + `test` all passed while the endpoint returned a 500.
The mutation run showed the model _request_ was entirely unguarded — dropping
the structured-output schema broke no test — and `.length(3)` on the response
schema turns a model returning two well-formed alternatives into a hard 502,
which the salvage path never sees because salvage runs only after a successful
parse. Both were observed live, not theorised.

## 7. What We Deliberately Don't Test

Exclusions agreed during the Phase 2 interview (Q5). Respect these unless
the underlying assumption changes.

- **UI snapshots** — they break on every style tweak and catch no behavioural
  regression. Re-evaluate if a rendering regression appears that no
  behavioural test caught. (Source: Phase 2 interview Q5.)
- **E2e through a real Garmin account** — slow, brittle, and dependent on a
  third-party server that PRD l. 60 explicitly describes as fragile. Risks
  #3 and #6 are attacked more cheaply at the sidecar boundary and against a
  real database. (Source: Phase 2 interview Q5.)
- **Model-based tests (LLM-as-judge, model-driven visual review)** —
  deliberately out of scope because of token cost. Consequence: §3 has no
  "AI-native layer" phase. Re-evaluate only if a regression appears that no
  deterministic test can catch cheaply. (Source: Phase 2 interview Q5.)
- ~~**Cost abuse of the recommendation endpoint (rate limiting)** — no such
  safeguard exists today.~~ **Withdrawn 2026-09-11 — this was factually
  wrong.** Research found a soft per-user daily generation cap, enforced,
  with its own table and a dedicated rate-limited response path. The
  mechanism exists and is cheap to test hermetically; the exclusion is
  removed and the path belongs to §3 Phase 2 (API endpoint contract).
  (Source: Phase 1 research, `testing-ai-response-contract`.)
- **The 10 s p95 recommendation budget** — a metric, not a test. It belongs
  to observability; risk #7 covers the testable part (a readable error
  state). (Source: PRD l. 90 + challenger pass.)

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-09-11
- Stack versions last verified: 2026-09-11
- AI-native tool references last verified: 2026-09-11 (none — the layer is
  deliberately excluded, see §7)

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive — in particular
  **when S-05 (`workout-step-detail`) lands**, which introduces a
  pace-plausibility guardrail; that guardrail does not demonstrably exist
  today, so the risk was deliberately excluded as speculative,
- a recommended tool's `checked:` date is older than three months,
- the tech stack changes (new framework, new test runner),
- §7 negative space no longer matches what the team believes.
