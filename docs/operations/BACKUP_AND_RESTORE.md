# PostgreSQL backup and restore runbook

## Backup contents

Each backup is a directory beneath `backups/`:

```text
ucm-costing-YYYYMMDDTHHMMSSsssZ/
  manifest.json
  database/
    ucm.dump
  data/
    uploads/
    reports/
    artifacts/
  output/
    pdf/
```

`ucm.dump` is a PostgreSQL custom-format dump. `manifest.json` records the
backup format, creation time, PostgreSQL server and migration versions, and
the exact byte length and SHA-256 of every managed file. Evidence, report, and
artifact files are part of application state; a database-only dump is not a
complete backup.

The supplied command requires application writes to be stopped. That gives
the database dump and managed-file copy one operational cutover point.
The restore connection must own the dedicated UCM database and its `public`
schema. Restore deliberately replaces that schema; do not share the database
with another application.

## Automatic daily production backup

The production `app` container creates one new verified backup every day at
06:00 New Zealand local time. Docker Compose sets `TZ=Pacific/Auckland`, so the
schedule follows New Zealand daylight-saving changes instead of using a fixed
UTC offset.

The production process supervises the HTTP server. At the scheduled time it:

1. stops accepting new requests and waits for active requests to finish;
2. stops background application maintenance and closes the database pool;
3. runs the same PostgreSQL-and-managed-file backup implementation used by the
   manual operator command;
4. verifies the PostgreSQL archive and every file hash; and
5. starts the HTTP server again whether the backup succeeded or failed.

This produces a short daily application outage. Follow the schedule and result:

```sh
docker compose logs --follow app
```

Successful output contains a JSON record with
`"status":"created-and-verified"` and the new backup path. A failure is logged
as `Scheduled backup failed`, after which the HTTP server is restarted. Alert
on that message and create a verified manual backup after correcting the cause.

The automatic scheduler has **no retention or deletion behavior**. It creates a
new timestamped directory and never removes or overwrites a completed backup.
Consequently the backup filesystem grows indefinitely. Monitor free space and
capacity trends; a full filesystem prevents future backups and can affect other
services if it shares their disk.

Automation does not make the local backup mount independent of the host. Copy
each completed directory to encrypted, access-controlled off-host storage and
verify it after transfer. Periodic restore drills remain required.

The supported topology is one `app` container. Do not scale it to multiple
replicas: each replica would have an independent daily timer, and the rest of
the application is intentionally documented as a single-instance deployment.

## Create and verify a manual backup

```sh
docker compose stop app
./scripts/backup.sh
./scripts/backup.sh --verify BACKUP_NAME
docker compose start app
```

To choose a unique, meaningful name:

```sh
./scripts/backup.sh --name before-release-2026-08-15
```

When PostgreSQL is running under Compose, the wrapper executes the
profile-gated `backup` container on the private database network. It refuses
to run while `app` is running. The operation:

1. records the database identity and migration version;
2. creates and validates a PostgreSQL custom-format dump;
3. copies uploads, reports, generated artifacts, and exported PDFs;
4. rejects symbolic links and unsafe paths;
5. hashes every file into the manifest;
6. verifies the complete staged backup;
7. publishes it with an atomic directory rename.

Success is reported only as `created-and-verified`. An interrupted
`.backup-*` staging directory is not a valid backup.

The manual command does not delete or overwrite older backups either.

Verification rejects an unsupported manifest, missing or extra files,
symbolic links, unsafe paths, byte-length or hash mismatches, and an invalid
PostgreSQL archive:

```sh
./scripts/backup.sh --verify BACKUP_NAME
```

Run this after every off-host transfer.

## Empty-target recovery drill

Do not discover restore problems during an incident. On an isolated host or
isolated Compose project:

1. create an empty PostgreSQL database and empty data/output directories;
2. provide its migrator-capable `DATABASE_URL`, `UCM_DATA_ROOT`,
   `UCM_OUTPUT_ROOT`, and the backup root;
3. run:

   ```sh
   node scripts/restore.mjs --from BACKUP_NAME
   ```

4. start the matching application version;
5. verify health, project totals, report/evidence hashes, sign-in, and the
   audit-ledger chain.

Never point a drill at live directories or the live database. The restore
command refuses a non-empty destination without `--replace`. Even for an empty
target, it creates a verified `pre-restore-*` recovery backup before making a
change. That dump is what lets automatic rollback return the database to a
truly empty schema if post-restore validation fails.

## Replace live state

Schedule downtime and identify the exact verified backup name:

```sh
./scripts/backup.sh --verify BACKUP_NAME
docker compose stop app
./scripts/restore.sh --from BACKUP_NAME --replace
docker compose up -d
docker compose ps
curl --fail --show-error http://127.0.0.1:8080/health
```

Every restore creates a separate verified `pre-restore-*` recovery backup of
the current database and managed files. The requested backup and the recovery
backup are never overwritten. Restore then:

1. verifies the source manifest, dump, and managed-file hashes;
2. stages the source files without touching live paths;
3. moves the old managed directories into hidden rollback directories and
   installs the staged directories;
4. streams the custom archive into `psql`, resetting and rebuilding the
   `public` schema inside the same single transaction;
5. checks the restored migration version and re-hashes every installed managed
   file against the source manifest;
6. removes the hidden rollback directories only after all validation passes.

If any database or managed-file validation fails after replacement is
attempted, restore first rebuilds PostgreSQL from the recovery dump, then puts
the original managed directories back, and verifies them against the recovery
manifest. The command exits non-zero and says that automatic rollback
completed. It never reports `restored-and-verified` for a rolled-back attempt.

Keep the automatic recovery backup until the restored system has been
accepted. A successful result may include `cleanupWarnings`; investigate those
paths, but do not repeat a successful restore merely to remove hidden staging
directories.

If the error says `AUTOMATIC ROLLBACK DID NOT COMPLETE`, keep the application
stopped. Preserve the command output, the source and recovery backups, and the
reported `.restore-rollback-*` directories. Recover the database and files
together from the named `pre-restore-*` backup; do not delete the PostgreSQL
volume or manually splice database and file states.

## Post-restore acceptance

1. Confirm the health response reports PostgreSQL ready, the expected migration
   version, verified source documents, and the expected project count.
2. Sign in through the configured HTTPS origin.
3. Verify membership and role behavior with a read-only user and an editor.
4. Compare a known project vehicle total to the accepted source record.
5. Download a recent report and evidence file and compare their SHA-256 values.
6. Run:

   ```sh
   docker compose run --rm app \
     node apps/server/dist/cli/verify-audit-ledger.js
   ```

7. Confirm there are no failed evidence-cleanup tasks or stale render leases in
   application logs.

## Retention

Completed backups are retained indefinitely by both the automatic and manual
commands. There is deliberately no prune command, retention count, age limit,
or storage lifecycle operation in the application. An operator who ever needs
to remove a backup must do so outside the application as a separate,
explicitly reviewed action.

The local backup mount does not protect against host or disk loss. Copy every
completed backup directory to encrypted, access-controlled off-host storage,
preserving directory names and every byte. Name an owner for capacity
monitoring and off-host replication, and test restores on another system.

The backup contains account and session metadata, team-confidential
engineering evidence, cost data, and immutable reports. It does not contain
`UCM_SHARED_ACCESS_KEY`, `UCM_VIEWER_ACCESS_KEY`, or `UCM_ADMIN_ACCESS_KEY`;
all remain in protected
deployment configuration. Apply the same access, retention, and
incident-response controls as the live system.
