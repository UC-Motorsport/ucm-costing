# Agent Notes

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation.

## Setup and verification

- Use Node.js 24 and `npm ci`. Run `npm run references:fetch` to obtain the
  checksum-pinned official runtime inputs; see `docs/references/SOURCES.md`.
- With Docker available, `npm run dev:stack` starts an isolated development
  database and app with test credentials; `npm run dev:stack:check` runs checks.
- Direct checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
  Set `TEST_DATABASE_URL` to an isolated PostgreSQL instance whose role can
  create databases. Many backend integration tests skip without it; report
  that as incomplete verification, not a full pass.
- Never commit `.env`, live credentials, or operational data. Development
  needs no production secrets. `npm run env:init -- https://your-host.example`
  generates new production secrets locally and refuses to overwrite `.env`.
