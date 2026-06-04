---
project: GainPace
researched_at: 2026-05-31
recommended_platform: Cloudflare Workers
runner_up: Netlify
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 SSR
  runtime: Cloudflare Workers (workerd)
  auth_database: Supabase (external)
  adapter: "@astrojs/cloudflare"
---

## Recommendation

**Deploy on Cloudflare Workers.**

The project's `@astrojs/cloudflare` adapter already targets the workerd runtime — no adapter swap or stack changes are needed. At 10k–100k monthly requests the Free tier (100k req/day) is more than sufficient at $0/month, directly addressing the cost-minimization priority. Cloudflare edge isolates warm in under 10ms, keeping AI recommendation calls well within the PRD's 10-second p95 budget — a constraint Netlify's 2–6 second Node.js cold starts would threaten. The platform scores Pass on all five agent-friendly criteria, and the GA MCP + Claude Code integration is the strongest of any platform evaluated.

## Platform Comparison

| Platform | CLI-first | Managed | Agent docs | Deploy API | MCP | Score | Est. monthly cost |
|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass | **5.0** | $0 (free tier) |
| **Netlify** | Pass | Pass | Pass | Pass | Pass | **5.0** | $0 (free tier) |
| **Vercel** | Pass | Pass | Pass | Pass | Partial¹ | **4.5** | $0² |
| Railway | Pass | Partial | Pass | Pass | Pass | **4.5** | ~$5–10 |
| Fly.io | Pass | Partial | Partial | Pass | Partial³ | **3.5** | ~$5–10 |
| Render | Partial⁴ | Pass | Pass | Partial⁴ | Pass | **3.5** | $7 min |

¹ Vercel MCP: beta as of April 2026  
² Vercel Hobby plan: non-commercial use only; commercial projects require Pro at $20/seat/month  
³ Fly.io MCP (`flymcp`): experimental/preview as of 2026-05-31  
⁴ Render CLI lacks a `rollback` subcommand; rollback requires the REST API or dashboard  

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

The `@astrojs/cloudflare` adapter is already installed and configured — this is the zero-adapter-change path. The Free tier covers 100k requests per day (~3M/month), far beyond MVP scale for a low-QPS solo project. Edge isolates have no meaningful cold start (<10ms), which is critical given the PRD's 10s p95 AI recommendation requirement. `wrangler` provides full CLI coverage: `wrangler deploy`, `wrangler rollback`, `wrangler tail` for log streaming, and `wrangler secret put` for secrets management. Cloudflare publishes `llms.txt`, `llms-full.txt`, and GitHub-hosted docs source, and has a GA MCP server with a dedicated Claude Code integration guide at `developers.cloudflare.com/agent-setup/claude-code/`. One deployment architecture clarification is required before go-live: the tech-stack.md records `deployment_target: cloudflare-pages`, but `@astrojs/cloudflare` has dropped Pages SSR support — SSR must target Workers via `wrangler deploy`, not the Pages Git integration.

#### 2. Netlify

Netlify also scores 5/5 on the criteria and offers a free tier that covers 125k function invocations/month. The official MCP server reached GA in February 2026 and integrates with Claude Code. The critical gap for this project is **cold start latency**: Netlify Functions (Node.js) cold-start at 2–6 seconds when containers are idle. At low QPS — the expected MVP profile — idle containers are common, meaning many requests pay this penalty before the AI call even begins. That makes the PRD's 10s p95 AI recommendation budget tight to unachievable. Additionally, deploying on Netlify requires swapping `@astrojs/cloudflare` for `@astrojs/netlify`, which introduces adapter-specific code changes. It is the right runner-up if Cloudflare Workers become untenable.

#### 3. Vercel

Vercel scores 4.5/5, with the only gap being its MCP server (beta as of April 2026, not yet GA). The CLI is mature and scriptable, docs readability is among the best of any platform (full `llms-full.txt`), and the adapter swap (`@astrojs/vercel`) is a single command. The Hobby plan's **non-commercial restriction** is a soft blocker: if GainPace ever generates revenue (paid plan, monetized API), Hobby is contractually off-limits and Pro ($20/seat/month) becomes mandatory. Cold starts on Hobby are present but less severe than Netlify for typical I/O-bound SSR workloads. Ranked third because of the commercial-use ambiguity and the need to swap the adapter.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **The project's `deployment_target: cloudflare-pages` is incorrect for SSR.** Recent `@astrojs/cloudflare` adapter versions have dropped Cloudflare Pages SSR support. SSR must deploy to Workers via `wrangler deploy`. The CI pipeline in `.github/workflows/ci.yml` targets Pages-style auto-deploy-on-merge; this must be updated to use `wrangler deploy` or the Pages Workers integration — the two are different commands with different routing models.

2. **Supabase `@supabase/ssr` + workerd has known sharp edges.** The `updateSession()` middleware pattern may create a new `Set-Cookie` header on every request in some version combinations (a performance regression documented in community threads). The workerd cookie mutation API differs subtly from Node.js; intermittent auth failures have been reported before the correct implementation pattern was found.

3. **New per-Worker-per-day billing (GA 2026-05-26) on Paid plans.** At Free tier this does not apply. However, upgrading to Paid for higher CPU time introduces a daily per-Worker charge even when idle. This is easy to misread as a simple "$5/month flat" tier.

4. **10ms CPU time limit per invocation on Free tier.** CPU time (not wall-clock time) is capped at 10ms. An AI call that awaits a Claude API response for several seconds counts nearly zero CPU. But a Zod-heavy validation + SSR render cycle that exceeds 10ms CPU will fail on Free tier without a clear error message.

5. **Cloudflare-specific API surface creates migration friction.** Code written against `context.locals.runtime`, `getRuntime()`, and KV/D1 bindings does not transfer to Node.js without adapter-specific refactoring. Acceptable for MVP, but the dependency should be acknowledged.

### Pre-Mortem — How This Could Fail

Six months in, GainPace was running on Cloudflare Workers but had accumulated a cluster of small integration failures. Day one: the Pages-style CI auto-deploy produced a broken bundle because the adapter had silently dropped Pages SSR support — `wrangler pages deploy` and `wrangler deploy` are different commands, and nobody had updated the CI step. After wiring `wrangler deploy` into GitHub Actions, the app deployed but Supabase auth failed intermittently in production. The `@supabase/ssr` `setAll` cookie path behaved differently under workerd's `Request` immutability model; sessions expired silently. Three late nights later, a community workaround patched it, but confidence in the auth layer was shaken. Then the Claude API calls started timing out for users in Eastern Europe — Cloudflare routed Workers requests to a PoP with higher latency to the Anthropic API region, pushing p95 above 10 seconds on AI calls. Fixing this required Cloudflare Smart Routing configuration, which wasn't in the original plan. Each failure was individually solvable, but none of them appeared in the official docs or the adapter README.

### Unknown Unknowns

- **Pages vs Workers is not a naming difference — it is a different deploy pipeline.** `wrangler pages deploy` targets Cloudflare Pages; `wrangler deploy` targets Workers. For SSR via `@astrojs/cloudflare`, the correct path is Workers. The existing `deployment_target: cloudflare-pages` entry in tech-stack.md must be corrected before the first production deploy, and CI must use `wrangler deploy`.

- **`auto_minify` must be disabled in the Cloudflare dashboard.** Cloudflare's legacy Auto Minify feature (HTML/CSS/JS rewriting, enabled by default on some zones) breaks React hydration at runtime (`Hydration completed but contains mismatches`). This is a dashboard toggle — not a `wrangler.jsonc` or `astro.config.mjs` setting — and is easy to miss on first deploy.

- **Compatibility date silently falls back.** The `compatibility_date` in `wrangler.jsonc` determines which workerd behaviors are active. An outdated or absent date causes the runtime to silently use older semantics, a common cause of "works locally, fails in prod" bugs. Pin to a recent known-good date from day one.

- **Supabase `@supabase/ssr` `setAll` regression on workerd.** Some version combinations cause `updateSession()` to emit a `Set-Cookie` on every request even when the session is unchanged. The fix requires diffing old and new cookies before writing — not present in the default Supabase SSR template for edge environments.

- **`nodejs_compat` compatibility flag changes module resolution.** Some npm packages require the `nodejs_compat` flag; others work without it but break when it is enabled. Test each third-party dependency in `wrangler dev` (not just `astro dev`) before adding it — the two dev servers use different runtimes.

## Operational Story

- **Preview deploys**: Cloudflare Workers supports versioning and gradual rollouts. For PR previews, the recommended pattern is to use Cloudflare Pages for the *static* preview URL (branch-auto-deploy) while SSR Workers are deployed to a staging Worker with a separate route. Alternatively, `wrangler deploy --name gainpace-preview-<pr>` creates a named Worker per PR. Preview Workers are not password-protected by default — add Cloudflare Access (zero-config, free tier) to restrict access to preview environments.

- **Secrets**: Environment variables live in two places. For local `npm run dev` (Vite path): `.env` file. For `wrangler dev` and production Workers: `.dev.vars` (local) and `wrangler secret put KEY` (production). Production secrets are stored encrypted in Cloudflare's secrets store and injected into the Worker runtime as `env.KEY` — never visible in logs or `wrangler.jsonc`. Rotation: `wrangler secret put KEY` followed by `wrangler deploy` activates the new value. Secret names must match the `[vars]` or `wrangler secret` entries — a mismatch causes a silent runtime `undefined`, not a deploy error.

- **Rollback**: `wrangler rollback` reverts to the immediately prior deployment; `wrangler rollback <version-id>` targets a specific historical version. Both create a new deployment (not a git revert) and propagate across all routes in seconds. Database migrations made between deploys do NOT roll back automatically — schema changes must be considered separately.

- **Approval**: An agent may perform `wrangler deploy`, `wrangler rollback`, and `wrangler tail` unattended with a scoped API token. Human-only actions: rotating the primary Supabase service key, deleting the Workers project, modifying DNS or Zero Trust policies, and any Cloudflare billing changes. Scope the CI/agent API token to `Workers Scripts:Edit` for one project only — no DNS, no billing, no cross-project access.

- **Logs**: `wrangler tail` streams live structured logs from the running Worker to the terminal — no dashboard required. Filter by status (`--status error`), IP, sampling rate, or request URL. For historical logs, Cloudflare Workers Logs (GA) stores logs to R2 with configurable retention. Structured JSON output is available with `--format json`.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| CI uses `wrangler pages deploy` for SSR (wrong command) | Unknown unknowns | High | High | Update CI to use `wrangler deploy`; update tech-stack.md `deployment_target` to `cloudflare-workers`; verify with `wrangler deploy --dry-run` before first merge |
| Supabase SSR `updateSession()` cookie regression on workerd | Unknown unknowns | Medium | High | Test auth flow in `wrangler dev` before merging the initial Supabase integration; apply cookie-diff workaround documented in Supabase community thread if regression is observed |
| `auto_minify` breaks React hydration | Unknown unknowns | Medium | Medium | Disable Auto Minify (HTML/CSS/JS) in the Cloudflare zone dashboard on first deploy setup; add to deployment runbook |
| Compatibility date silent fallback causes prod/local divergence | Unknown unknowns | Medium | Medium | Pin `compatibility_date` to `2025-09-01` or later in `wrangler.jsonc`; never leave it absent or at a date >12 months old |
| Free tier 10ms CPU cap causes silent failures under load | Devil's advocate | Low | Medium | Profile CPU usage in `wrangler dev` with `wrangler dev --inspector-port 9229`; if CPU >8ms per request, upgrade to Paid plan ($5/mo) |
| CloudFlare edge routing increases Claude API p95 for some regions | Pre-mortem | Low | Medium | Add `ANTHROPIC_API_KEY` regional routing awareness if p95 exceeds 8s in monitoring; use `wrangler tail` to detect elevated latency by PoP before it becomes a user complaint |
| Vendor lock-in via Cloudflare-specific adapter APIs | Devil's advocate | High (certain) | Low (MVP scope) | Accept for MVP; document Cloudflare-specific callsites in a `# cloudflare-specific` inline comment if migration is a future concern |
| `nodejs_compat` flag interaction breaks third-party packages | Unknown unknowns | Low | Medium | Test each new npm dependency in `wrangler dev` before merging; enable `nodejs_compat` only if required by a specific package |

## Getting Started

The project is already configured for Cloudflare Workers. Three corrections are needed before the first production deploy:

1. **Correct the deploy target in CI.** The current workflow uses auto-deploy-on-merge to Cloudflare Pages. For Workers SSR, replace the Pages deploy step with:
   ```bash
   npx wrangler deploy
   ```
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository secrets. Scope the API token to `Workers Scripts:Edit` for this project only.

2. **Verify `wrangler.jsonc` targets Workers (not Pages).** Confirm the config has:
   ```json
   {
     "name": "gain-pace",
     "compatibility_date": "2025-09-01",
     "compatibility_flags": ["nodejs_compat"]
   }
   ```
   If the file references Pages-specific fields (`pages_build_output_dir`), remove them and switch to the Workers format.

3. **Disable Auto Minify in Cloudflare dashboard.** Navigate to the zone → Speed → Optimization → turn off Auto Minify for HTML, CSS, and JavaScript. Do this before the first SSR deploy to prevent React hydration errors.

4. **Set production secrets via wrangler:**
   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_KEY
   ```

5. **Validate locally against workerd before merging:**
   ```bash
   npm run dev          # starts wrangler dev (workerd runtime)
   npx wrangler deploy --dry-run --outdir ./dist-preview
   ```
   `wrangler dev` is the fidelity target for production — `astro dev` uses Vite/Node and will not surface workerd-specific issues.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup details (GitHub Actions step authoring)
- Production-scale architecture (multi-region, HA, DR)
