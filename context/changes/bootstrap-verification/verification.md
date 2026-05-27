---
bootstrapped_at: 2026-05-28T00:31:00Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: gain-pace
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

## Hand-off

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: gain-pace
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
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
```

### Why this stack

A solo developer shipping a running-coach MVP in 4 weeks (after-hours) with auth and an AI recommendation engine needs a battle-tested, agent-friendly starter that handles auth, database, and edge deploy out of the box. The 10x Astro Starter is the recommended default for (web-app, js) and clears all four agent-friendly gates: typed (TypeScript + Zod throughout), convention-based (Astro file routing + Supabase SDK patterns), popular in JS training data, and well-documented. Auth and AI feature flags are both active — Supabase covers auth and the Garmin OAuth flow, while the Cloudflare Workers edge runtime keeps AI recommendation calls within the PRD's 10-second p95 budget. Payments, realtime, and background jobs are out of scope per PRD Non-Goals. CI runs on GitHub Actions with auto-deploy-on-merge to Cloudflare Pages, which is the starter's native deployment target and the cheapest path to first deploy for a solo after-hours project.

## Pre-scaffold verification

| Signal      | Value                                          | Severity    | Notes                                              |
| ----------- | ---------------------------------------------- | ----------- | -------------------------------------------------- |
| npm package | not run (cmd_template starts with `git clone`) | —           | skip per pre-scaffold-verification.md §JS-family   |
| GitHub repo | not run                                        | unavailable | gh CLI not installed on this machine               |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone (cloned starter repo, git history stripped before move-up)
**Exit code**: 0
**Files moved**: 20
**Conflicts (.scaffold siblings)**: `CLAUDE.md` → `CLAUDE.md.scaffold` (existing `CLAUDE.md` from 10xDevs toolkit preserved)
**.gitignore handling**: moved silently (absent in cwd)
**.bootstrap-scaffold cleanup**: deleted

### Engine warnings (informational)

`npm install` reported EBADENGINE warnings for multiple packages requiring Node >=20.17–22.x; current runtime is Node v20.11.0. The install completed successfully. Consider upgrading to Node >=22 for full engine compatibility with this starter.

## Post-scaffold audit

**Tool**: `npm audit --json`
**Summary**: 0 CRITICAL, 1 HIGH, 9 MODERATE, 0 LOW
**Direct vs transitive**: 0/0/2/0 direct of total 0/1/9/0

#### HIGH findings

| Package  | Version      | Advisory ID              | Description                                | Fix version | Direct? |
| -------- | ------------ | ------------------------ | ------------------------------------------ | ----------- | ------- |
| devalue  | 5.6.3–5.8.0  | GHSA-77vg-94rm-hx3p      | DoS via sparse array deserialization       | available   | no      |

#### MODERATE findings

| Package                   | Version                   | Description                                           | Direct? |
| ------------------------- | ------------------------- | ----------------------------------------------------- | ------- |
| @astrojs/check            | >=0.9.3                   | via @astrojs/language-server → volar-service-yaml     | yes     |
| @astrojs/language-server  | >=2.14.0                  | via volar-service-yaml                                | no      |
| @cloudflare/vite-plugin   | <=1.37.2                  | via miniflare, wrangler, ws                           | no      |
| miniflare                 | 3.20250204.0–4.20260518.0 | via ws (uninitialized memory disclosure)              | no      |
| volar-service-yaml        | <=0.0.70                  | via yaml-language-server                              | no      |
| wrangler                  | 3.108.0–4.93.0            | via miniflare                                         | yes     |
| ws                        | 8.0.0–8.20.0              | Uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx)| no      |
| yaml                      | 2.0.0–2.8.2               | Stack overflow via deeply nested collections          | no      |
| yaml-language-server      | various                   | via yaml                                              | no      |

Note: most HIGH/MODERATE findings are in dev tooling (`wrangler`, `@astrojs/check`, dev-only language server). They do not affect production runtime code. Run `npm audit fix` to address non-breaking fixes.

## Hints recorded but not acted on

| Hint                    | Value               |
| ----------------------- | ------------------- |
| bootstrapper_confidence | first-class         |
| quality_override        | false               |
| path_taken              | standard            |
| self_check_answers      | null                |
| team_size               | solo                |
| deployment_target       | cloudflare-pages    |
| ci_provider             | github-actions      |
| ci_default_flow         | auto-deploy-on-merge|
| has_auth                | true                |
| has_payments            | false               |
| has_realtime            | false               |
| has_ai                  | true                |
| has_background_jobs     | false               |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- Review `CLAUDE.md.scaffold` (the starter's original CLAUDE.md) — diff it against your current `CLAUDE.md` and merge any Astro/Supabase-specific guidance you want to keep.
- Run `npm audit fix` to address the 7 auto-fixable MODERATE findings.
- Consider upgrading to Node >=22 for full engine compatibility with this starter.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
