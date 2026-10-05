# UCM Costing architecture

## Purpose and rules boundary

UCM Costing is a self-hosted Formula SAE-Australasia competition-costing
workspace for University of Canterbury Motorsport. Catalogue totals are
Formula SAE Universal $, not NZD, AUD, or actual team expenditure.

The 2026 Formula SAE-Australasia Local Addendum v1.2 Appendix PDA-2 is the
governing checksum-pinned external rule source. Each project and immutable report pins the
rule document, Catalogue 26_R1 release, and their SHA-256 digests. Published
equations are implemented exactly; missing organizer templates,
classifications, deadlines, scoring inputs, or external APIs are never
inferred.

## Runtime

```text
Browser
  |
  | HTTPS
  v
TLS reverse proxy
  |
  | loopback HTTP :8080
  v
Node/Express application
  |-- serves the compiled React/Vite client
  |-- authenticates users and authorizes project actions
  |-- validates writes and performs exact Decimal calculations
  |-- renders reports, XLSX, previews, and manual submission ZIPs
  |
  +-- private PostgreSQL 15
  +-- /app/data/uploads
  +-- /app/data/reports and artifacts
  +-- /app/output/pdf
  +-- /app/backups
```

Compose runs a one-shot migrator with a migration-capable role, then the
application with a separate least-privileged role. PostgreSQL is reachable only
on an internal Compose network. The application port binds to host loopback by
default; the browser-facing boundary is the external TLS proxy.

The runtime image is read-only and unprivileged, drops Linux capabilities,
sets `no-new-privileges`, and uses an in-memory `/tmp`. Only the data, output,
and backup roots are writable. `/health` checks PostgreSQL migration state,
verified source files, project count, and durable cleanup status without
exposing credentials.

## Code boundaries

- `apps/web` is the React 19 client built and served through Vite 8.
- `apps/server` is the Express API, PostgreSQL persistence layer, security and
  ledger layer, import pipeline, evidence store, validation engine, and
  document/artifact renderer.
- `packages/domain` contains exact-decimal calculations, catalogue formula
  parsing, hierarchy rules, amendment equations, and rule-workflow validation
  with no dependency on Express or PostgreSQL.
- `docs/references/official` and the pinned addendum PDF are immutable source
  bytes baked into the image and verified before use.
- `scripts` contains PostgreSQL/file backup and guarded restore commands.

Money and quantities cross API and database boundaries as decimal strings and
PostgreSQL `numeric`; client-supplied subtotals are never trusted. Mutable rows
carry optimistic versions. The server derives catalogue costs and multipliers
from the project's pinned release. Tooling requires an explicit
fraction-included and production-volume factor; it never assumes 3000.

## Identity, authorization, and request integrity

The initial administrator is created through an operator CLI. Administrators
then add active users and manage `admin`, `editor`, and `viewer` roles across
the team's season workspaces.

Every active user signs in with their complete registered email and the
runtime-only key for their role. Editors use `UCM_SHARED_ACCESS_KEY`, viewers
use `UCM_VIEWER_ACCESS_KEY`, and administrators use the separate
`UCM_ADMIN_ACCESS_KEY`. Production requires three independently generated,
distinct keys of at least 32 bytes by default. A production-only, default-off
`UCM_ALLOW_WEAK_ACCESS_KEYS` exception permits an operator to rely on
independent perimeter controls while retaining a 6-byte floor and distinct-key
validation. No key is stored on user records or built into the browser.
Sessions use random bearer tokens in `HttpOnly`, `SameSite=Strict`,
`Secure` production cookies, and only token digests are stored. A constrained,
explicit tailnet-testing mode can temporarily omit `Secure` only for one exact
Tailscale IPv4 HTTP origin with no trusted proxy; HTTPS remains the default and
required Internet topology. Each session is also bound to a SHA-256 fingerprint
of the applicable key, so rotating a key
automatically invalidates sessions issued under its previous value. Startup
persists the current fingerprints in `app_metadata` and permanently revokes
affected sessions whenever either changes, including when a former key is
restored. Logout, account disablement, role changes, and security-state changes
also revoke sessions.

The three keys form role-class access boundaries, not individual authentication.
No key can authenticate an account in another role. Possession of
the administrator key plus knowledge of an active administrator email permits
impersonating that administrator; the editor and viewer keys permit the same
within their respective roles. The email labels audit-ledger actions
but does not cryptographically prove which person performed them.

Except for health and login, all APIs require a valid session. Browser
mutations also require an allowed exact origin and CSRF token. Helmet supplies
security headers, request bodies and uploads are bounded, and login, mutation,
upload, import, and rendering paths are rate-limited. Request IDs and salted IP
hashes flow into audit context.

## PostgreSQL data model and ledger

PostgreSQL stores:

1. verified source documents, immutable catalogue releases/items, and formula
   provenance;
2. users, sessions, season workspaces (stored in the legacy-named `projects`
   table), declarations, hierarchy nodes, exact cost lines, and cross-season
   lineage;
3. import batches/rows/issues, evidence metadata, durable file-cleanup work,
   report render leases, and immutable report snapshots;
4. generated artifacts, CAIR requests, Cost Amendment drafts/items/snapshots,
   and manual submission state;
5. an ordered append-only audit ledger.

One non-archived workspace may exist per season. `is_historical` is an explicit
server-enforced read-only boundary, while the newest non-historical season is
the compatibility default for `/api/workspace`. Cross-season subtree copies
are preview-hashed, idempotent, and recorded in both `cost_node_lineage` and the
audit ledger.

Portable archives use a versioned canonical JSON manifest plus evidence bytes
in a bounded ZIP. Restore validates safe paths, expansion limits, hierarchy,
installed rule/catalogue hashes, catalogue references, and every evidence hash
before creating a new draft workspace with regenerated database IDs. Derived
reports and workflow history are excluded; the operational backup remains the
complete disaster-recovery artifact.

Every accepted domain mutation appends its ledger row in the same transaction.
Each entry contains actor, project, request, entity, before/after state,
timestamp, metadata, the prior entry hash, and its own canonical SHA-256.
An advisory transaction lock serializes the chain. PostgreSQL triggers reject
ledger update/delete, source/catalogue mutation, completed report mutation,
and completed artifact mutation. An operator command recomputes the entire
chain.

Workspace ownership is also a database invariant rather than an API convention.
Composite foreign keys prevent hierarchy parents, evidence, import provenance,
report snapshots, amendments, artifacts, submissions, and durable submission
preparations from crossing project boundaries. Deferrable constraint triggers
cover the few indirect links whose project is reached through an owning batch,
cost line, CAIR, or amendment. The ownership migration first rejects any
pre-existing mismatch, then installs and validates every new constraint.

Project report-setup confirmation is a versioned declaration, not a boolean.
It records actor, timestamp, and a hash of the attested fields. Editing a
covered field invalidates the declaration.

## File and report integrity

Uploads are staged under generated names, hashed, committed with metadata, and
cleaned through a durable queue on failure or deletion. Cascading hierarchy
deletion queues every descendant evidence path in the database transaction,
then attempts cleanup immediately after commit. A periodic worker retries
failures with leased `FOR UPDATE SKIP LOCKED` claims.

No download trusts the filesystem alone. Source, evidence, report, and artifact
bytes are opened, hashed, checked for change during verification, compared to
the stored digest, and only then streamed. Generated artifacts are likewise
hashed from their completed regular staging file rather than trusting a
generator-supplied digest.

Reports render from an immutable JSON snapshot containing source provenance,
project records, exact rollups, validation, and selected evidence hashes.
UCM25 page sizes, typography, table geometry, and ordering are retained, but
technical frames contain only verified project evidence. A draft without
evidence shows an honest empty frame; a competition-ready report blocks.
There are no production demo drawings, dimensions, or isometrics.

Supporting XLSX and submission ZIPs derive from the immutable report snapshot,
not mutable live project rows. Cost Amendment previews freeze their source
amendment version and complete machine-readable per-BoX calculation, include
that snapshot in immutable artifact metadata, and watermark the PDF as
preview-only. Final CAR locking remains blocked until the official 2026
template and classification guidance are installed.

Submission packaging first commits one durable preparation and fixed package
and manifest artifact reservations. A session advisory lock permits only one
generator for that preparation; a retry reuses verified complete artifacts,
resets failed reservations under the same IDs, and reconstructs the same
manifest from the frozen preparation timestamp and actor. The submission row
and preparation completion commit atomically, and every reserve, attempt,
failure, artifact transition, and completion is ledgered. Recording the
organizer receipt atomically marks the project submitted. Subsequent project
metadata changes require an explicit status change back to draft or review;
prior report and submission snapshots remain immutable.

## Project and import lifecycle

Production startup installs only verified reference data and never creates a
project. Creating a project creates its real vehicle/system roots in one
transaction. Archive is the normal removal operation and is reversible;
reports, provenance, and ledger history remain intact.

The production server build defines production mode at compile time,
tree-shakes the development demo installer, and has a Docker build assertion
that rejects any emitted demo-seed chunk. The synthetic fixture remains in
source only for an explicitly enabled non-production environment or isolated
test.

The legacy SQLite importer is an explicit development/operator transition
command. It verifies SQLite integrity and managed-file hashes, imports into an
empty PostgreSQL target, reconciles counts, and excludes the known demo project
unless a non-production operator deliberately requests it. In-app legacy
import history/recovery/cancellation exists only in development and test; the
production build cannot enable its router.

## Backup and recovery

A complete backup combines:

- a PostgreSQL custom-format dump;
- uploads, reports, generated artifacts, and exported PDFs;
- a manifest containing schema/server identity, byte sizes, and SHA-256
  digests.

The application must be stopped to align database and managed-file state.
Backup stages and verifies everything before atomic publication. Restore
rejects an unverified or non-empty target unless replacement is explicit,
creates a verified pre-restore recovery backup, restores PostgreSQL in one
transaction, stages managed files, and verifies the resulting migration
version. Detailed commands are in `docs/operations/`.

## Deployment constraints

- The supported release topology uses one application container because local
  managed files are part of the same logical state as PostgreSQL.
- TLS termination and an exact HTTPS allowed origin are mandatory for browser
  use in production.
- PostgreSQL and managed files must be backed up together and copied to
  encrypted off-host storage.
- At every API startup, managed-file reconciliation verifies that each
  complete evidence, report, and generated-artifact record still points to a
  regular file with the recorded length and SHA-256. Startup fails closed on
  missing or altered referenced bytes and removes unreferenced crash remnants
  only from application-owned managed directories.
- Rule ambiguities remain explicit blockers or notices; they are not converted
  into invented defaults.
- Competition submission is a manual, actor-attributed receipt workflow until
  an official organizer integration and credentials exist.
