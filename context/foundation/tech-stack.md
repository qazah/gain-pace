---
starter_id: 10x-astro-starter
package_manager: npm
project_name: gain-pace
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-workers
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: false
---

## Why this stack

A solo developer shipping a running-coach MVP in 4 weeks (after-hours) with auth and an AI recommendation engine needs a battle-tested, agent-friendly starter that handles auth, database, and edge deploy out of the box. The 10x Astro Starter is the recommended default for (web-app, js) and clears all four agent-friendly gates: typed (TypeScript + Zod throughout), convention-based (Astro file routing + Supabase SDK patterns), popular in JS training data, and well-documented. Auth and AI feature flags are both active — Supabase covers auth and the Garmin OAuth flow, while the Cloudflare Workers edge runtime keeps AI recommendation calls within the PRD's 10-second p95 budget. Payments, realtime, and background jobs are out of scope per PRD Non-Goals. CI runs on GitHub Actions with auto-deploy-on-merge to Cloudflare Pages, which is the starter's native deployment target and the cheapest path to first deploy for a solo after-hours project.
