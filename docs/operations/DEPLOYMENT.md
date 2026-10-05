# Production deployment runbook

Before building, use Node.js 24 and run `npm run references:fetch` to obtain
the checksum-pinned official inputs. Alternatively place the exact files listed
in `docs/references/SOURCES.md` yourself and run `npm run references:check`.
References and optional logos are excluded from source control.

## Supported topology

The supported deployment is one application container behind a
TLS-terminating reverse proxy, with one private PostgreSQL service and three
managed file directories:

| State | Storage | Contents |
| --- | --- | --- |
| PostgreSQL | named `postgres-data` volume | projects, users, sessions, costs, immutable snapshots, workflow state, and the audit ledger |
| `UCM_DATA_DIR` | host bind mount at `/app/data` | evidence uploads, reports, and generated artifacts |
| `UCM_OUTPUT_DIR` | host bind mount at `/app/output` | explicitly exported PDFs |
| `UCM_BACKUP_DIR` | host bind mount at `/app/backups` | verified PostgreSQL-and-file backup sets |

PostgreSQL is attached only to Compose's internal `database` network and has
no host-published port. The application port binds to `127.0.0.1` by default
so it can be reached by the host reverse proxy without being exposed as plain
HTTP. Do not publish port 8080 directly to the Internet.

The production `app` process also supervises the daily backup schedule. At
06:00 `Pacific/Auckland` it gracefully stops the HTTP server, creates and
verifies a PostgreSQL-and-managed-file backup, and restarts the server. No
completed backup is automatically deleted.

## First deployment

1. Install Docker Engine and the Compose plugin (or Docker Desktop), copy the
   repository to the host, and enter its root.

2. Create and protect the environment file:

   ```sh
   npm run env:init -- https://costing.example.org
   ```

   This requires Node.js 24 and creates `.env` with mode 0600,
   seven independent random secrets, and the supplied HTTPS origin. It refuses
   to overwrite an existing file. On a Docker-only host, copy `.env.example`
   to `.env`, run `chmod 600 .env`, and fill the values manually as below.

   Set distinct `UCM_DB_MIGRATOR_PASSWORD` and `UCM_DB_APP_PASSWORD` values.
   Generate `UCM_SHARED_ACCESS_KEY`, `UCM_VIEWER_ACCESS_KEY`, `UCM_ADMIN_ACCESS_KEY`,
   `UCM_CSRF_SECRET`, and `UCM_AUDIT_IP_SALT` independently:

   ```sh
   openssl rand -hex 32
   ```

   Run the command separately for each value. All three access keys must contain
   at least 32 UTF-8 bytes in production and must differ. Editors use
   `UCM_SHARED_ACCESS_KEY`, viewers use `UCM_VIEWER_ACCESS_KEY`, and
   administrators use `UCM_ADMIN_ACCESS_KEY`. Never
   reuse a database, request-integrity, or other access secret as an access key.
   An operator deliberately relying on an independent access-control layer may
   set `UCM_ALLOW_WEAK_ACCESS_KEYS=true` to accept distinct access keys from 6
   through 1024 UTF-8 bytes. This production-only exception defaults off,
   emits a startup warning, and must not be the only protection for an
   Internet-reachable deployment. The database and backups contain access-key
   fingerprints; predictable short keys can be confirmed offline if those
   files are stolen, so encrypt and tightly restrict every backup copy.

   Set `UCM_ALLOWED_ORIGINS` to the exact public HTTPS origin, for example
   `https://costing.example.org`. Wildcards, paths, fragments, and blank
   entries are rejected.

3. Create the file mounts:

   ```sh
   mkdir -p data output backups
   ```

   On Linux, set `UCM_UID` and `UCM_GID` in `.env` to the owner of those
   directories, then grant only that account access:

   ```sh
   chown -R "$(id -u):$(id -g)" data output backups
   chmod 700 data output backups
   ```

4. Build, migrate, and start:

   ```sh
   docker compose up --build -d
   docker compose ps
   curl --fail --show-error http://127.0.0.1:8080/health
   docker compose logs --tail=50 app
   ```

   The one-shot `migrate` service applies ordered PostgreSQL migrations using
   the migrator role, idempotently creates or repairs the non-superuser
   `ucm_app` runtime role, rotates it to `UCM_DB_APP_PASSWORD`, and grants only
   the required privileges. This also recovers a retained PostgreSQL volume
   whose runtime role was never initialized. The password is passed as a
   bound value and is never printed. Existing role memberships and stale
   direct or `PUBLIC` privileges are removed; migration fails closed if the
   runtime role owns database objects. The `app` service refuses to start
   against an older schema.
   Startup installs the checksum-verified rule source and Catalogue 26_R1
   reference rows, but creates no project, hierarchy, user, or synthetic cost
   data. The app log must also report that automated backups run daily at
   `06:00 Pacific/Auckland` and show the next scheduled time.

5. Create the first active administrator:

   ```sh
   docker compose run --rm app \
     node apps/server/dist/cli/create-admin.js \
     --email admin@example.org \
     --name "Team Administrator"
   ```

   The command does not read or prompt for an individual password and refuses
   to bootstrap a second initial administrator. Sign in with the complete
   registered email (`admin@example.org` in this example) and the administrator
   key from `UCM_ADMIN_ACCESS_KEY`. Further users are added as active accounts
   and assigned roles directly by an administrator in the Users screen.

6. Configure a reviewed reverse proxy to:

   - terminate TLS with a valid certificate;
   - proxy the configured HTTPS host to `127.0.0.1:8080`;
   - preserve the original `Host` header;
   - cap request bodies consistently with the application;
   - apply access and security logging appropriate for confidential
     engineering data.

   Keep `UCM_BIND_ADDRESS=127.0.0.1` and set `UCM_TRUST_PROXY_HOPS` to the
   reviewed, exact proxy-hop count (`1` for this topology). Express then uses
   the proxy-supplied client address for per-client rate limiting and salted
   audit-IP hashes without trusting an arbitrary number of forwarding hops.
   Browser sessions use `HttpOnly`, `Secure`, `SameSite=Strict` cookies in
   production and therefore require HTTPS.

7. Sign in through the HTTPS origin and confirm:

   - the bill of materials opens directly with the team vehicle and standard systems;
   - the verified rule and catalogue release are shown;
   - an editor can create and save a record;
   - a second stale edit receives a version conflict rather than overwriting;
   - an evidence download reports the persisted SHA-256;
   - the Activity view attributes the mutations to the correct actor.

## Security and roles

All application APIs except `/health` and login require an authenticated
session. Mutating browser requests require a valid origin and CSRF token.
Login, mutation, upload, and report routes are rate-limited; security headers
are supplied by Helmet.

System roles are `admin`, `editor`, and `viewer` across active season workspaces.
Administrators add active users and manage users and controlled imports;
editors can mutate team costing data; viewers are read-only. Disabling a user
or changing sensitive account state revokes sessions.

`UCM_SHARED_ACCESS_KEY`, `UCM_VIEWER_ACCESS_KEY`, and
`UCM_ADMIN_ACCESS_KEY` authenticate only their matching role. These keys prove access to a role class
but do not prove which person selected an email at sign-in: anyone who knows
the administrator key can impersonate any known active administrator, and
anyone who knows a role key can impersonate any known active account in that
role. Audit entries therefore record the claimed account, not individual
cryptographic proof. Restrict each key to its intended trusted group and use a
stronger identity provider if individual non-repudiation is required.

To rotate a key, replace its value in the protected `.env` and recreate or
restart the app container. Sessions are bound to the applicable key version,
and startup permanently revokes affected sessions whenever any configured
fingerprint changes. Accounts that used the changed key must sign in again.
Restoring a former key is treated as another rotation and does not restore the
sessions that previously used it.

### Temporary direct Tailscale IP testing

The normal production topology requires HTTPS and issues a Secure
`__Host-ucm_session` cookie. When an operator needs to test the deployment
directly at a Tailscale IPv4 address before attaching the reviewed HTTPS
tunnel, the app supports one narrowly constrained exception:

```text
UCM_BIND_ADDRESS=100.64.0.10
UCM_HTTP_PORT=8080
UCM_ALLOWED_ORIGINS=http://100.64.0.10:8080
UCM_ALLOW_INSECURE_HTTP=true
UCM_TRUST_PROXY_HOPS=0
```

Replace the example address with the host's exact address from
`tailscale ip -4`. The override accepts only one explicit HTTP origin within
Tailscale's `100.64.0.0/10` range and requires zero trusted proxy hops. In this
mode the app uses an `HttpOnly`, `SameSite=Strict` session cookie without the
`Secure` or `__Host-` properties and omits HSTS and CSP HTTP-to-HTTPS upgrade.
Startup logs a warning.

This is temporary private-tailnet testing, not an Internet deployment. Confirm
tailnet ACLs restrict the host, never bind to `0.0.0.0` or the LAN address, and
do not expose the port through Tailscale Funnel or a router. Before enabling a
Cloudflare Tunnel, restore the secure settings:

```text
UCM_BIND_ADDRESS=127.0.0.1
UCM_ALLOWED_ORIGINS=https://costing.example.org
UCM_ALLOW_INSECURE_HTTP=false
UCM_TRUST_PROXY_HOPS=1
```

Recreate the app container and verify HTTPS sign-in. The secure setting changes
the cookie name, so users must sign in again after this cutover.

Every accepted mutation writes an append-only, hash-chained ledger entry in
the same PostgreSQL transaction. PostgreSQL triggers reject ledger updates and
deletes. Verify the complete chain periodically and after restore:

```sh
docker compose run --rm app \
  node apps/server/dist/cli/verify-audit-ledger.js
```

Treat a failed ledger check as an integrity incident. Preserve the database
and logs; do not "repair" rows in place.

## Configuration

`UCM_BIND_ADDRESS` defaults to loopback and `UCM_HTTP_PORT` defaults to 8080.
`UCM_SHARED_ACCESS_KEY` and `UCM_ADMIN_ACCESS_KEY` are required in production,
must differ, and must each contain at least 32 bytes unless the explicit
production-only `UCM_ALLOW_WEAK_ACCESS_KEYS=true` exception is enabled. The
exception permits 6 through 1024 bytes and does not weaken origin, rate-limit,
session, or authorization checks. The keys are supplied only at runtime; do
not place either in source, browser configuration, logs, or an application
image.
`UCM_DB_POOL_MAX` is the maximum runtime pool size and must fit
within the database connection budget. Database, statement, lock, and
idle-transaction timeouts have bounded defaults in Compose.

The runtime container is unprivileged, read-only apart from the explicit
mounts and `/tmp`, has no Linux capabilities, and uses
`no-new-privileges`. Fix mount ownership rather than running it as root or
making directories world-writable.

`UCM_ENABLE_LEGACY_IMPORTS` is intentionally absent from production Compose,
and the server ignores it whenever production mode is active. Legacy import
preview/history/cancellation exists only in development and transition tests;
the offline SQLite migration CLI is the supported controlled migration path.

## Isolated developer stack

Do not weaken the production `.env` to test from localhost. The repository
provides a separate development image, Compose project, and set of volumes:

```sh
npm run dev:stack
```

Open `http://127.0.0.1:8080` and use administrator email
`test@localhost.invalid` with administrator key `admin-test`. The development
editor key is `test`; the viewer key is `viewer-test`. These weak keys and the test account exist only
when the development image is built and
`UCM_ENABLE_DEVELOPMENT_ACCOUNT=true` is set by `docker-compose.dev.yml`. The
production bundle does not contain the development seed command, and the normal
`docker compose` project does not share the development database.

Stop the developer stack while retaining its disposable state with
`npm run dev:stack:stop`. Use `npm run dev:stack:reset` only when intentionally
discarding the development database and managed-file volumes. Neither command
targets the production Compose project.

## Updating

Treat every update as a state-preserving operation. The PostgreSQL named
volume, `.env`, and the `data/`, `output/`, and `backups/` directories are
persistent production state, not release artifacts. Never delete, replace, or
include them in a source transfer. In particular, never run
`docker compose down -v`, `docker volume rm`, `docker system prune --volumes`,
or an unreviewed `rsync --delete` against the deployment directory.

Before changing code or applying a migration, record the current health,
migration version, project count, and any acceptance totals or file hashes
that will be checked after the update. Confirm that the filesystem has enough
free space for both a new backup and the image build.

Then stop writes and create a uniquely named, verified backup using the
recorded backup procedure. Replace the example name with the release and UTC
timestamp being deployed:

```sh
cd /srv/ucm
docker compose stop app
./scripts/backup.sh --name before-release-20260802T043000Z
./scripts/backup.sh --verify before-release-20260802T043000Z
docker compose start app
curl --fail --show-error http://127.0.0.1:8080/health
```

Do not proceed unless both backup commands succeed and verification reports a
valid PostgreSQL archive plus matching managed-file hashes. If creation or
verification fails, run `docker compose start app`, confirm the old release is
healthy, and stop the deployment. Do not use an interrupted `.backup-*`
directory. Keep the verified backup until the new release has passed all
acceptance checks and has also been copied to the normal encrypted off-host
backup location.

For a working-tree deployment from the operator machine, preview the exact
source delta before applying it. The exclusion rules protect live secrets,
database-adjacent state, managed files, and host-generated dependencies. The
trailing slashes and exact destination are significant:

```sh
cd /path/to/ucm-working-tree
rsync -az --delete-delay --dry-run --itemize-changes \
  --exclude='/.git/' \
  --exclude='/.env' \
  --exclude='/data/' \
  --exclude='/output/' \
  --exclude='/outputs/' \
  --exclude='/backups/' \
  --exclude='/tmp/' \
  --exclude='/artifacts/' \
  --exclude='/execplans/' \
  --exclude='.DS_Store' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='coverage/' \
  --exclude='**/__pycache__/' \
  --exclude='*.pyc' \
  ./ deploy@your-host.example:/srv/ucm/
```

Review the dry-run output and confirm it contains no change beneath `.env`,
`data/`, `output/`, or `backups/`. Only then repeat the same command without
`--dry-run`. Do not add `--delete-excluded`; excluded production state must
remain protected. `--delete-delay` is used so removed source files do not
survive the release, but deletion is deferred until the transfer completes.

Validate and build the transferred source before recreating the application:

```sh
cd /srv/ucm
docker compose config --quiet
npm run references:fetch
docker compose build
docker compose up -d --no-build
docker compose ps
curl --fail --show-error http://127.0.0.1:8080/health
```

`docker compose up --build -d` recreates release containers but preserves the
explicitly named `ucm-costing_postgres-data` volume and all bind-mounted
managed directories. Ordered migrations run transactionally before the new
application starts. Do not substitute a teardown-and-recreate command.

After an update:

1. confirm `migrate` completed successfully, both long-running services are
   healthy, and the health response still reports the expected project count;
2. compare the recorded pre-update database row counts and audit-ledger tip;
   expected migrations may add rows or ledger entries, but existing counts
   must not unexpectedly decrease;
3. sign in through HTTPS and verify a known real project total (a credential
   migration or access-key rotation deliberately requires a fresh sign-in);
4. download a recent immutable report and compare its recorded SHA-256;
5. download a known evidence file;
6. run the audit-ledger verifier;
7. inspect `docker compose logs --tail=200 app migrate postgres` for errors;
8. verify the public HTTPS health endpoint and application root through the
   reverse proxy.

If verification fails, stop the app and follow the restore runbook. Never use
`docker compose down -v`; it deletes the PostgreSQL volume.
