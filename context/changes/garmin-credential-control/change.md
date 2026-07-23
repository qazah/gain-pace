---
change_id: garmin-credential-control
title: Garmin credential control and privacy — disconnect + cookie-only opt-out
status: implemented
created: 2026-07-23
updated: 2026-07-23
archived_at: null
---

## Notes

Roadmap slice **S-07** (`context/foundation/roadmap.md`). Two capabilities on one shared connect/credential surface:

1. **Disconnect** — one action deletes the entire `garmin_credentials` row (session blob + AES-GCM encrypted password + cached snapshot); leaves `workout_selections` and `race_goals` intact.
2. **"Don't store my credentials" checkbox** — cookie-only mode: nothing written server-side, session lives in an encrypted httpOnly session-scoped cookie, runner re-authenticates each new session. No silent re-login in this mode by design.

Design locked during brainstorming (2026-07-23): strict data hygiene (zero server-side rows in ephemeral mode, no persisted mode marker), single combined slice.

Open unknowns for `/10x-plan`: cookie size vs ~4KB limit for the `PersistedSession` blob; session-sourcing refactor of `getDashboardData`/`fetchData` (DB vs cookie via a shared "session provider" seam); MFA pending-blob in cookie mode; cookie hardening (httpOnly/Secure/SameSite/session-scoped). See S-07 in the roadmap for full detail.
