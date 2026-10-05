# UCM Costing

A self-hosted Formula SAE-Australasia costing workspace for University of
Canterbury Motorsport. It maintains collaborative, auditable bills of
materials in PostgreSQL, validates report readiness, preserves immutable
source and report snapshots, and produces the supporting artifacts used by the
team's manual competition-submission process.

Competition values are displayed as **Universal $**, not NZD or AUD. The
governing source is the Formula SAE-Australasia 2026 Local Addendum v1.4,
Appendix PDA-2.

## Getting started

Use Node.js 24 and Docker with Compose. Clone the public repository:

```sh
git clone https://github.com/UC-Motorsport/ucm-costing.git
cd ucm-costing
npm ci
npm run references:fetch
npm run dev:stack
```

Open `http://127.0.0.1:8080` and sign in with `test@localhost.invalid` and
administrator key `admin-test`. These public development credentials are for
the isolated local stack only. See Development below for hot reload.

Official rule documents and the catalogue are downloaded separately and
verified against pinned SHA-256 hashes. Team records and optional report
logos are not included. If a download fails or its checksum changes, see
[reference sources](docs/references/SOURCES.md). The application remains pinned
to the documented 2026 rules; verify their applicability before competition use.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source code is licensed under the [MIT license](LICENSE).
Third-party documents, team records and marks remain subject to their owners'
rights. See the [release guide](docs/operations/OPEN_SOURCE_RELEASE.md).

## Start with Docker Compose

Docker Desktop or Docker Engine with Compose is the only production runtime
prerequisite. The optional key generator below requires Node.js 24;
on a Docker-only host, copy `.env.example` to `.env` and fill it using the
[deployment runbook](docs/operations/DEPLOYMENT.md).

```sh
npm run references:fetch
npm run env:init -- https://costing.example.org
# Use your real HTTPS origin above; existing .env files are never overwritten.
mkdir -p data output backups
docker compose up --build -d
docker compose ps
```

The application listener is loopback-only by default. Put a reviewed
TLS-terminating reverse proxy in front of it and open the exact HTTPS origin
configured in `UCM_ALLOWED_ORIGINS`. The `app` service should become
`healthy`; plain HTTP is suitable only for the local health probe.

A fresh production database installs the verified rule sources, official
catalogue, and the current UC Motorsport 2026 workspace with its vehicle and
standard system hierarchy. It contains no synthetic parts or costs. Create the
first active administrator with the built operator CLI before signing in.

```sh
docker compose run --rm app \
  node apps/server/dist/cli/create-admin.js \
  --email admin@example.org \
  --name "Team Administrator"
```

The command does not prompt for an individual password. Sign in with the
complete registered email address (`admin@example.org` in this example) and
the administrator key configured in `UCM_ADMIN_ACCESS_KEY`. Administrators add
further active users directly from the Users screen. Editors sign in with
`UCM_SHARED_ACCESS_KEY`, viewers use `UCM_VIEWER_ACCESS_KEY`, and every
administrator uses the separate administrator key.

One role-class key cannot authenticate another role. These keys
still prove access only within a role class, not which person is signing in:
anyone with the administrator key can select any known active administrator
email, and anyone with an editor or viewer key can select a known active account
in that matching role. Audit attribution therefore records the email claimed at
login rather than providing individual cryptographic proof. Keep all three keys
within their intended trusted groups. Rotating a key and restarting the app
automatically invalidates existing sessions that used it.

## Seasons and portable workspaces

The season selector keeps each active season in its own workspace. Historical
CSV imports are administrator-only and create a server-enforced read-only
workspace. Assemblies, subassemblies, and parts can be copied into the current
season only after an explicit conflict preview; copied evidence is internal
until reviewed for the target car.

The workspace-files control downloads a versioned `.ucm.zip` archive containing
project settings, hierarchy, exact cost lines, and hash-verified evidence. An
administrator can dry-run an archive restore before any write occurs and then
restore it as a new season. Generated reports, submissions, activity history,
and setup attestations stay in operational backups and are intentionally not
replayed as live editable state.

Production rejects access keys below 32 bytes by default. The explicit
`UCM_ALLOW_WEAK_ACCESS_KEYS=true` exception permits distinct keys of at least
6 bytes only for deployments protected by an independent access-control layer;
it emits a startup warning and materially reduces resistance to guessing.

## Development

Docker and Node.js 24 are required. Check the local prerequisites and
Compose configuration first:

```sh
npm ci
npm run references:fetch
npm run dev:stack:doctor
```

For normal implementation work, start hot-reload development:

```sh
npm run dev:watch
```

This keeps PostgreSQL, migrations, and seed data in Docker while running the
API with `tsx watch` and the frontend with Vite on the host. Hot reload uses
its own `ucm_watch` database so its records and host-managed files stay
separate from the all-Docker app. Open
`http://127.0.0.1:5173`; source edits reload without rebuilding an image. The
API is at `http://127.0.0.1:8080`, PostgreSQL is bound only to
`127.0.0.1:54329`, and mutable files live under the ignored
`tmp/dev-watch/` directory. Press Ctrl-C to stop the watchers. PostgreSQL stays
running for a faster restart.

For a production-shaped smoke test in which the built app also runs in Docker,
use:

```sh
npm run dev:stack
```

When the command reports ready, open `http://127.0.0.1:8080` and sign in with
administrator email `test@localhost.invalid` and administrator key
`admin-test`. The development editor key is `test` and viewer key is
`viewer-test`. This stack has its
own Compose project, PostgreSQL volume, managed-file volumes, fixed
development-only database credentials and access keys, localhost origin
policy, and non-production browser cookie. It does not use `.env` or
production data.

Useful lifecycle commands are:

```sh
npm run dev:stack:test    # full automated suite in an ephemeral container
npm run dev:stack:check   # typecheck, lint, test, and build in Docker
npm run dev:stack:status
npm run dev:stack:logs
npm run dev:stack:stop   # preserves development data
npm run dev:stack:reset  # deletes development containers and volumes
```

Docker tests connect to the same PostgreSQL server but create random temporary
databases whose names begin with `ucm_test_`; they never modify the seeded
`ucm` development database and delete each temporary database afterward. Test
containers do not bind-mount or rewrite the host worktree.

`UCM_DEV_HTTP_PORT=8081`, `UCM_DEV_WEB_PORT=6173`, and
`UCM_DEV_DB_PORT=54330` select different loopback ports. Pass the same values
on later lifecycle commands. Starting either workflow again is idempotent:
migrations rerun safely and the test administrator is reconciled without
duplication.

Host-side verification remains available for the fastest focused checks:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Back up and restore

The production Compose app automatically creates and verifies one backup every
day at **06:00 New Zealand time** (`Pacific/Auckland`, including daylight-saving
changes). It gracefully pauses the application while PostgreSQL and managed
files are captured, then restarts it whether the backup succeeds or fails.
Completed automatic backups are never deleted or overwritten. Monitor the
backup filesystem because it will grow without bound, and copy completed
backup directories to encrypted off-host storage.

Follow the app logs to see the next scheduled time and each result:

```sh
docker compose logs --follow app
```

Manual backups remain available for upgrades and other operator-selected
cutover points. Quiesce application writes, then create and verify a
PostgreSQL/files backup:

```sh
docker compose stop app
./scripts/backup.sh
./scripts/backup.sh --verify BACKUP_NAME
docker compose start app
```

Restore is intentionally more guarded:

```sh
docker compose stop app
./scripts/restore.sh --from BACKUP_NAME --replace
docker compose up -d
```

See
[`docs/operations/BACKUP_AND_RESTORE.md`](docs/operations/BACKUP_AND_RESTORE.md)
for automatic and manual operation, backup contents, empty-target recovery
drills, verification behavior, capacity monitoring, and off-host guidance.

## One-time legacy SQLite import

The SQLite reader is a development-only dependency and is not present in the
production application runtime. Import into a freshly migrated, otherwise
empty PostgreSQL database. The command runs SQLite `quick_check`, verifies
source/evidence/report bytes against every stored SHA-256, imports in one
PostgreSQL transaction, and reconciles table counts before commit. The known
synthetic demo project is excluded by default.

For a local PostgreSQL target:

```sh
DATABASE_URL='postgresql://migration-role:password@host/empty_ucm' \
  npm run db:migrate:sqlite -- \
  --sqlite /absolute/path/ucm-costing.sqlite \
  --data-root /absolute/path/legacy-data \
  --entry-number PROJECT_ID=E13
```

With the internal Compose database, use the development/test image and mount
the old database and its managed files read-only:

```sh
docker compose stop app
docker compose run --rm \
  -v /absolute/path/legacy:/legacy:ro \
  test npm run db:migrate:sqlite -- \
  --sqlite /legacy/ucm-costing.sqlite \
  --data-root /legacy/data \
  --entry-number PROJECT_ID=E13
```

Repeat `--entry-number PROJECT_ID=VALUE` for every imported real project.
Nothing is inferred. `--include-demo` is available only outside production and
must be deliberately supplied.

## Documentation

- [Architecture](ARCHITECTURE.md): runtime, data, security and recovery model.
- [Contributing](CONTRIBUTING.md): development and verification.
- [Deployment](docs/operations/DEPLOYMENT.md): production setup and updates.
- [Backup and restore](docs/operations/BACKUP_AND_RESTORE.md): recovery runbook.
- [Cloud development](docs/operations/CODEX_CLOUD.md): isolated cloud setup.
- [Reference sources](docs/references/SOURCES.md): exact versions and checksums.
- [Costing research](docs/research/FORMULA_SAE_A_COSTING_2026.md): implementation context.
- [Historical tools](scripts/README.md): optional migration and PDF utilities.
