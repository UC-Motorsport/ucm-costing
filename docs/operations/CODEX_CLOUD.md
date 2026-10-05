# Codex Cloud setup

Create a cloud environment for this repository. Give the
GitHub connection access to the repository, then prepare and verify the
environment before publishing it. GitHub Actions secrets do not automatically
configure Codex Cloud. This project needs no external API keys for development.

## Installation

Request Node.js 24, PostgreSQL 15 and its client tools, `poppler-utils`,
Python 3, make, and a C++ compiler. Run `npm ci` and `npm run references:fetch` to download and verify
exact official runtime inputs. No private team assets are needed for ordinary
development or the automated suite. Optional historical extraction requires
separately supplied authorized input files; see `scripts/README.md`.

## Start services

If Docker and Compose are available, use the existing isolated workflow:

```sh
npm run dev:stack
npm run dev:stack:check
```

It configures development-only database credentials, applies migrations,
seeds the development administrator, and runs checks with PostgreSQL enabled.
The admin login is `test@localhost.invalid` with key `admin-test`.

If Docker is unavailable, configure the environment's start skill to start
PostgreSQL locally, create a development database and a test role with
permission to create databases, and set `DATABASE_URL` and
`TEST_DATABASE_URL`. Set `UCM_DATABASE_SSL=disable` and
`UCM_TEST_DATABASE_SSL=disable` only for this local database. Use
`NODE_ENV=development` and `UCM_ENABLE_DEVELOPMENT_ACCOUNT=true`, then run:

```sh
npm run db:migrate
npx tsx apps/server/src/cli/seed-development.ts
npm run dev
```

For the app, use the development values from `scripts/dev-stack-config.mjs`:
`UCM_ADMIN_ACCESS_KEY=admin-test`, `UCM_SHARED_ACCESS_KEY=test`, and
`UCM_VIEWER_ACCESS_KEY=viewer-test`. Configure `UCM_ALLOWED_ORIGINS` for the
actual development origins and store mutable files in workspace-local
`tmp/` directories. Reuse `createWatchEnvironment` when constructing the
startup environment, replacing its Docker database URL with the local one.
Set `VITE_DEVELOPMENT_ACCOUNT=true` to enable the frontend development login.

PostgreSQL must be started again when required in a new or resumed workspace;
do not assume a saved filesystem includes running processes. Use synthetic
or development data. Do not copy production `.env`, databases, or backups.

## Verify before publishing

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Direct checks require `TEST_DATABASE_URL` for backend integration coverage.
Confirm those tests ran rather than skipped, and check `/health` after starting
the app. Retain the tested install commands and service startup instructions
in the cloud environment.

## Production configuration

For a separate deployment, run:

```sh
npm run env:init -- https://your-costing-host.example
```

This creates an ignored `.env` with fresh database passwords, three role
access keys, a CSRF secret, and an audit salt. It never prints secret values
or overwrites an existing configuration. Follow `DEPLOYMENT.md` for HTTPS,
persistent storage, and first-administrator creation. Live keys belong in the
deployment's protected configuration, not the repository.
