# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start dev server (Cloudflare workerd runtime)
npm run build      # production build (SSR via @astrojs/cloudflare)
npm run preview    # preview production build locally
npm run lint       # ESLint with type-checked rules
npm run lint:fix   # auto-fix lint issues
npm run format     # Prettier (astro + tailwind plugins)
npx astro sync     # regenerate type declarations (run after adding env vars or content collections)
```

There are no test scripts yet. Pre-commit hooks (husky + lint-staged) run `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}`.

For local Supabase: `npx supabase start` (requires Docker). Copy the printed credentials into `.env` and `.dev.vars`.

## Architecture

**Astro 6 SSR app** deployed to Cloudflare Workers. `output: "server"` in `astro.config.mjs` — every page is server-rendered. React 19 is used only for interactive islands (hydrated via `client:load` / `client:idle`). Use Astro components for layout and static content.

### Auth

- `src/lib/supabase.ts` — factory that creates a Supabase SSR client with cookie-based sessions (`@supabase/ssr`). Returns `null` when env vars are missing so the app degrades gracefully instead of crashing.
- `src/middleware.ts` — runs on every request, attaches resolved user to `context.locals.user`. Add paths to `PROTECTED_ROUTES` to require auth.
- API endpoints at `src/pages/api/auth/{signin,signup,signout}.ts` — form POST handlers that redirect on success/failure with error as a query param.
- Env vars (`SUPABASE_URL`, `SUPABASE_KEY`) are declared via Astro's `env.schema` in `astro.config.mjs` as server-only secrets. Read them via `import { SUPABASE_URL, SUPABASE_KEY } from "astro:env/server"` — never from `process.env` directly.

### Key conventions

- **Path alias**: `@/*` → `./src/*` (tsconfig paths).
- **Class merging**: always use `cn()` from `@/lib/utils` (clsx + tailwind-merge) — never concatenate class strings manually.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style. Add new ones with `npx shadcn@latest add [name]`.
- **API routes**: export uppercase `GET`, `POST`, etc. Validate input with Zod.
- **Supabase migrations**: `supabase/migrations/YYYYMMDDHHmmss_description.sql`. Always enable RLS on new tables with per-operation, per-role policies.
- **React hooks**: extract to `src/components/hooks/`. No Next.js directives (`"use client"` etc.).
- **Business logic**: `src/lib/` or `src/lib/services/`. Shared entity/DTO types go in `src/types.ts`.
- **Config status**: `src/lib/config-status.ts` tracks missing env vars; `Layout.astro` renders error banners automatically for any unconfigured service.

### Environment

- `.env` — used by the Vite/Node dev path
- `.dev.vars` — used by the Cloudflare workerd dev runtime (`npm run dev`); takes precedence for `wrangler`-driven commands
- CI (`.github/workflows/ci.yml`) runs `astro sync → lint → build` on push/PR to `master`. Requires `SUPABASE_URL` and `SUPABASE_KEY` as GitHub repository secrets.

<!-- BEGIN @przeprogramowani/10x-cli -->

## 10xDevs AI Toolkit - Module 2, Lesson 5

Scale the single-change cycle into parallel work with **worktrees, goal-directed delegation, and multi-session orchestration**:

```
worktree per change -> /goal or claude -p -> PR -> review -> merge
```

The lesson focus is safe throughput: isolated contexts, choosing the right execution mode, and capping parallelism at review capacity.

### Task Router - Where to start

| Skill | Use it when |
| --- | --- |
| **Code isolation** | |
| `git worktree add` | You need a separate working directory for a parallel change. One change per worktree, one fresh agent context per worktree. |
| **Complex changes** | |
| `/10x-implement <change-id> phase <n>` | The change has multiple phases, needs manual gates, or benefits from interactive decision-making during execution. |
| **Simple changes** | |
| `/goal` | You have a clear, bounded task and want goal-directed delegation. The agent works autonomously toward the stated goal with a stop condition. |
| `claude -p` | You want headless execution for a well-defined task. The Ralph Wiggum loop (run, check, retry) is the universal autonomous pattern. |
| **Multi-session orchestration** | |
| Superset / Conductor / Antigravity / VS Code Agent View | You are running multiple agent sessions in parallel and need visibility, coordination, or session management across them. |

### Parallel work rules

- One change per worktree or isolated workspace. One fresh agent context per change.
- Choose interactive `/10x-implement` for complex changes, `/goal` or `claude -p` for simple ones.
- Parallelism is capped by review capacity. More agents without review means more unreviewed code, not higher throughput.
- The quality pain from faster shipping is intentional — it bridges into Module 3 testing gates.

### Lesson boundaries

- Do not reteach interactive `/10x-implement` or `/10x-impl-review`; those are Lessons 2 and 3.
- Do not introduce testing strategy here. The quality pain is the motivation for Module 3.
- Worktrees are a mechanism for isolation, not the topic of a full git tutorial.

### Paths used by this lesson

- `context/changes/<change-id>/` - active change folder
- `context/changes/<change-id>/plan.md` - implementation input for any execution mode

Skills must not write to `context/archive/`. Archived changes are immutable; if a resolved target path starts with `context/archive/`, abort with: "This change is archived. Open a new change with `/10x-new` instead."

<!-- END @przeprogramowani/10x-cli -->
