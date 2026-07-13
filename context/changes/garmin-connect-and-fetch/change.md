---
change_id: garmin-connect-and-fetch
title: Connect Garmin account and fetch today's workout + recent activity data live
status: implemented
created: 2026-06-14
updated: 2026-07-13
archived_at: null
---

## Notes

Implements roadmap slice **S-01** (north star) — see `context/foundation/roadmap.md`.

Outcome: runner connects their Garmin account via OAuth and sees today's scheduled
workout from their Garmin training plan alongside recent activity data (last 3–4
workouts + recovery metrics: sleep quality, HRV, Body Battery), fetched live.

PRD refs: FR-001, FR-002, FR-003, US-01. Prerequisite: F-01 (domain-schema, done).

Blocked in roadmap on two unknowns (both owner: user, both blocking):
1. No official Garmin API. The `garminconnect` Python lib does not run in the
   Cloudflare Workers JS edge runtime. The viable JS/TS approach (community JS
   wrapper, raw HTTP against Garmin Connect endpoints, or a thin proxy service)
   must be identified and validated before implementation.
2. PRD Open Question 1: what does the app show when the runner has no active
   Garmin Coach training plan? FR-003 ("view today's scheduled workout") needs a
   no-plan fallback UX decision.
