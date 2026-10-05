# Contributing

UCM Costing is a self-hosted Formula SAE-A costing workspace. Start with the
[README](README.md) and [architecture](ARCHITECTURE.md). Before proposing a
large change, describe the problem and expected behavior in an issue. Use a
branch or worktree and keep pull requests focused.

## Local setup

Use Node.js 24 (`nvm use` if available), npm, and Docker with Compose:

```sh
npm ci
npm run references:fetch
npm run dev:stack:doctor
npm run dev:watch
```

The reference command downloads three exact official documents and verifies
their SHA-256 hashes. They remain ignored local inputs. No private repository
access or production credentials are required. If an upstream file changes,
obtain the pinned version from its owner; do not weaken checksum validation.
The README describes test logins and the all-Docker alternative.

## Verification

```sh
npm run dev:stack:check
```

This runs typecheck, lint, tests and build with an isolated PostgreSQL service.
For direct host checks, use `npm run typecheck`, `npm run lint`, `npm test`, and
`npm run build`. Direct integration tests require `TEST_DATABASE_URL` pointing
to a disposable PostgreSQL 15 server whose role can create databases; never
point it at production. Missing database configuration skips integration
coverage and must be reported as incomplete verification.

When changing optional historical PDF tooling, install its separate Python
requirements and run the Python tests as described in `scripts/README.md`.

## Pull requests

Explain the problem, resulting behavior, and verification performed. Include
synthetic examples and screenshots when useful. Add regression coverage for
behavior changes; preserve immutable report snapshots, audit provenance and
source hashes. Describe schema changes and recovery implications explicitly.

Never include real team records, personal information, credentials, `.env`,
database dumps, generated reports or brand assets. Test fixtures must be
synthetic. Keep official documents outside Git and record their provenance in
`docs/references/SOURCES.md`. Dependency licenses remain applicable; see
[third-party notices](THIRD_PARTY_NOTICES.md).

Be respectful, explain technical disagreements, and keep feedback focused on
behavior and evidence. Report suspected vulnerabilities privately using
[SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree to license it under this project's
[MIT license](LICENSE). Submit only material you have permission to contribute,
and preserve applicable third-party notices.
