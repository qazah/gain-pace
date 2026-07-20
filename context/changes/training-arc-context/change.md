---
change_id: training-arc-context
title: Training arc context per AI recommendation
status: implementing
created: 2026-07-20
updated: 2026-07-21
archived_at: null
---

## Notes

from roadmap.md

Roadmap slice **S-04** (`training-arc-context`), Stream A. PRD refs FR-006 (must-have), US-01. Prereq **S-03** (`modifier-to-recommendation-loop`) — done/archived.

Outcome: runner sees a one-line training-arc note alongside each of the 3 workout alternatives, explaining how today's choice affects long-term progress toward their defined race goal.

Roadmap-flagged risk: this extends the S-03 AI prompt with an additional per-alternative output field. Low risk if S-03's structured-output schema already reserves this field; otherwise it needs a prompt change + response-schema migration. **Verify S-03's schema before planning.**
