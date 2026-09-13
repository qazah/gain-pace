---
project: "GainPace"
version: 1
status: draft
created: 2026-05-24
context_type: greenfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 4
  hard_deadline: null
  after_hours_only: true
---

## Vision & Problem Statement

Garmin Coach and similar structured training systems give the runner exactly one prescribed workout for today. There is no way to choose between alternatives — you either follow it or break the plan entirely. No middle path exists that respects the runner's long-term goal while fitting their actual day: poor recovery, a packed schedule, or a simple desire to run at a different effort level.

The market has over-solved in one direction: full coach experiences that generate rigid 12-week plans. The simpler, unaddressed need is a lightweight modifier layer — something that generates real workout alternatives for today, explains what each option trades away, and does not require the runner to choose between discipline and reality.

## User & Persona

**Primary persona:** A committed recreational runner who owns a Garmin device and follows a structured training plan toward a performance goal (a target race, a time benchmark, a fitness baseline). Not an elite athlete managed by a human coach. Not a beginner building a first habit. The committed middle tier: goal-oriented, tracking their workouts, but navigating real-world schedule and energy constraints daily.

The moment they reach for this product: they open their watch or app in the morning and see today's scheduled workout — but their body, schedule, or mood says something different. Right now, they have no intelligent alternative.

## Success Criteria

### Primary

Runner connects their Garmin account, sets today's modifiers (Time / Intensity / Feeling), receives 3 AI-generated workout alternatives (or a smaller set, flagged as reduced, when an option would be implausible), each with a plain-language explanation of what it trades away, and picks one — all within 3 user actions from the modifier screen.

### Secondary

Each recommendation includes a one-liner about how today's choice affects the runner's long-term training arc — not just what to do, but why it matters in context of recent load and upcoming targets.

### Guardrails

- AI must not recommend unsafe workloads. Volumes and intensities must stay within a plausible range given the runner's recent training history. Hallucinated loads (e.g., 30km sprint for a 5km/week runner) are a hard regression.

## User Stories

### US-01: Runner modifies today's workout based on available time and recovery

- **Given** a logged-in runner who has connected their Garmin account and defined a race goal
- **When** they open the app on a training day, set their modifiers (e.g., "30 min / Normal / Tired"), and request alternatives
- **Then** they see a primary recommended workout card plus up to 2 alternatives — fewer, with the reduction shown, when an option would be implausible — each with a plain-language explanation referencing their recovery score and race goal, and they can select one as today's committed workout

#### Acceptance Criteria

- Primary recommendation is visibly distinct from the 2 alternatives
- Each option includes at minimum: workout type, estimated duration, and a one-sentence explanation referencing recovery state or goal proximity
- The whole flow (login → modifiers → recommendation → selection) completes in ≤ 3 user actions on the modifier screen
- AI must not recommend a volume or intensity that is implausible given the runner's last 3–4 logged activities

## Functional Requirements

### Data & Goal

- FR-001: Runner can connect their Garmin account to the app. Priority: must-have

  > Socrates: Counter-argument considered: Garmin's unofficial API is fragile — one server-side change breaks the integration. Resolution: risk accepted; Strava API noted as fallback if Garmin API fails, but Garmin is primary (sleep/recovery data available only there).

- FR-002: App fetches runner's recent workout data from Garmin as AI context (last 3–4 activities + sleep quality, HRV, Body Battery). Priority: must-have

  > Socrates: Counter-argument considered: full history UI adds frontend work without improving recommendation quality. Resolution: FR split — fetch is must-have; UI display of history for the runner is nice-to-have (see FR-002b).

- FR-002b: Runner can view their recent training history pulled from Garmin. Priority: nice-to-have

  > Socrates: Demoted from must-have based on Socrates round — AI context fetch (FR-002) is the load-bearing piece; history UI is a UX enhancement.

- FR-003: Runner can view today's scheduled workout from their Garmin plan. Priority: must-have

  > Socrates: Counter-argument considered: Garmin plan data may not be accessible via unofficial API; runner may not use Garmin Coach at all. Resolution: stands as written — the product's core framing is adapting a scheduled workout; if no plan exists, this is surfaced as an Open Question.

- FR-008: Runner can define a long-term race goal (event name, date, distance, target finish time). Priority: must-have
  > Socrates: Counter-argument considered: date-sensitive goals require phase-aware AI prompts (base building vs. peak taper), adding prompt complexity. Resolution: structured goal kept as must-have — provides date/distance/time context in MVP; phase-specific prompt switching (weeks-to-race awareness) is post-MVP.

### Modification & Recommendation

- FR-004: Runner can set today's modifiers (Time available / Intensity preference / Feeling). Priority: must-have

  > Socrates: Counter-argument considered: modifiers may be redundant if Garmin's recovery score already tells the AI the runner's state. Resolution: Time modifier is irreducible — Garmin cannot know about a meeting that cuts the run short. Feeling and Intensity overlap with recovery data but capture explicit intent that sensor data alone cannot. All 3 kept.

- FR-005: Runner receives a primary AI-recommended workout card plus up to 2 alternatives ("if you prefer"), each with a plain-language explanation grounded in current recovery and active modifiers. When an option would be implausible it is dropped and the smaller set ships flagged as reduced, rather than the request failing. Priority: must-have

  > Socrates: Counter-argument considered: 3 equal options create paradox of choice. Resolution: UX reframed — primary card is the AI recommendation, 2 alternatives shown below with "if you prefer" framing. Same data, less decision friction.

- FR-006: Runner can see how each alternative affects their training arc toward the defined race goal. Priority: must-have

  > Socrates: No counter-argument — contextual explanation relative to a goal is the core differentiator. Even approximate LLM reasoning beats zero context.

- FR-007: Runner can select one of the alternatives shipped — 3, or fewer when the set was reduced — as today's workout. Priority: must-have
  > Socrates: Counter-argument considered: selection is informational only in MVP — no push to Garmin watch; runner must recall it manually. Resolution: limitation accepted; the selection closes the decision loop and logs the commitment. Garmin .fit write-back is post-MVP.

## Non-Functional Requirements

- The runner receives visible AI-generated recommendations within 10 seconds (p95) of requesting them. Any operation exceeding 2 seconds must show continuous visible progress feedback — the runner must never wait in silence.
- The runner's Garmin account credentials leave no trace accessible to the runner after the authorization flow completes.

## Business Logic

The app selects and ranks up to 3 workout alternatives for today by weighing the runner's recent training load, current recovery state, defined race goal, and expressed modifiers — and identifies which alternative best fits the runner's current day. An alternative that fails the plausibility rules above is dropped rather than shipped; the runner is told the set was reduced.

**Inputs the rule consumes:**

- Last 3–4 completed workouts from Garmin (distance, pace, heart rate)
- Last night's recovery metrics from Garmin: sleep quality, HRV, Body Battery
- Today's runner-set modifiers: time available, intensity preference, self-reported feeling
- Defined race goal: event date, target distance, target finish time

**Output:** A primary recommended workout (the best fit for today) and 2 alternatives, each with a plain-language explanation of what it trades in context of the runner's recovery state and race goal proximity.

**How the runner encounters it:** On the main screen after setting modifiers, the runner sees the primary recommendation card prominently, with 2 "if you prefer" alternatives below. No raw numbers or training science jargon — only plain-language justification the runner can act on.

## Access Control

Login required: email + password, or OAuth (provider TBD in stack selection). Flat user model — every authenticated account is a self-managing runner with identical access. No admin panel, no coach/athlete role split in MVP.

Unauthenticated users cannot reach any training data or generate recommendations. Garmin account credentials are stored per user after initial connection.

## Non-Goals

- **No push to Garmin watch** — workout selection in the app is informational only. Automatic .fit file upload to the Garmin training calendar is explicitly post-MVP.
- **No full 12-week plan generation** — the app recommends today's workout, not a full seasonal training block. Periodization planning is out of scope.
- **No proprietary training load algorithm (ATL/CTL)** — the app uses contextual AI reasoning instead of a mathematical Training Load model. Building a physiological engine is out of scope.
- **No social features** — no leaderboards, sharing, kudos, or community feed. This is a personal training assistant, not a social platform.

## Open Questions

1. **What happens when the runner has no active Garmin training plan?** FR-003 frames the core product experience as adapting a scheduled workout. If the runner does not use Garmin Coach or has no active plan, the product's primary framing breaks down. Owner: user. Resolution needed before UX design begins.
