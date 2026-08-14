# Koban

Self-hosted multi-workspace Kanban board with sprints, an async AI queue, and an
MCP server. See `SPEC.md` for the architecture and `PLAN.md` for the roadmap.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Drizzle ORM ·
Neon Postgres · Auth.js v5 (GitHub).

## Setup

1. **Environment**

   ```bash
   cp .env.example .env.local
   npx auth secret          # writes AUTH_SECRET
   ```

   Fill in:

   | Variable | Where it comes from |
   | --- | --- |
   | `DATABASE_URL` | Neon project → Connection string |
   | `AUTH_SECRET` | `npx auth secret` |
   | `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub → Settings → Developer settings → OAuth Apps |
   | `ALLOWED_EMAILS` | Comma-separated. Only these addresses may sign in; the first becomes workspace owner. |

   GitHub OAuth app callback URL: `http://localhost:3000/api/auth/callback/github`.

2. **Database**

   ```bash
   pnpm db:push     # apply the schema to Neon
   pnpm db:seed     # workspace, 4 columns, labels, one active sprint, sample cards
   ```

3. **Run**

   ```bash
   pnpm dev
   ```

   Sign in with GitHub at <http://localhost:3000>. An address outside
   `ALLOWED_EMAILS` is rejected before any user row is created.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Dev server (Turbopack) |
| `pnpm build` | Production build — needs `DATABASE_URL` in the environment |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm db:push` | Push schema straight to the database |
| `pnpm db:generate` | Emit a SQL migration into `drizzle/` |
| `pnpm db:seed` | Idempotent seed |

## Layout

```
src/
  app/           routes (App Router)
  auth.ts        Auth.js v5 — adapter, GitHub provider, allowlist
  auth.config.ts edge-safe half, imported by middleware.ts
  db/
    schema.ts    all 15 tables
    seed.ts      idempotent seed script
  lib/
    env.ts       zod-validated server environment
    workspace.ts membership bootstrap on first sign-in
```

## Notes

- Membership is granted on sign-in (`events.signIn`), so a new allowlisted dev
  gets access to the seeded workspace without manual SQL.
- Every tenant-scoped read joins up to `workspace_id` in the same query. See the
  non-negotiable rules in `SPEC.md`.
