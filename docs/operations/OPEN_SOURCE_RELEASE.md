# Public source releases

The original private repository contains team documents and operational
records in its Git history, as well as a private release attachment. Do not
make that repository public merely because the current files are cleaned up.
Use a new repository with a reviewed, history-free source snapshot.

## Licensing and repository

The public repository is `https://github.com/UC-Motorsport/ucm-costing`.
The project uses the MIT license; workspace package metadata identifies it as
`MIT`. Preserve `LICENSE` and the third-party notices in source distributions.
Do not publish reference documents, marks or Docker images containing them
without the applicable permission.

Maintainers should enable private vulnerability reporting and require CI and
review for changes to the default branch. Check collaborator permissions and
publication settings separately from source files.

## Build a source candidate

Commit the intended source changes first. From the private cleanup checkout:

```sh
npm run source:export -- /absolute/path/to/new-public-source
```

The destination must not exist. The command copies tracked working-tree files
and applies additional exclusions for private records, downloaded references,
branding, runtime data, internal plans and build output. It does not copy Git
metadata or initialize a remote. Untracked source must be added to Git before
export. Keep the original private repository and its release attachments private.

Inspect the entire output, including comments and test fixtures. Run a secret
scanner on the candidate and review every finding; a filename filter cannot
prove source text contains no confidential content. Also review source and
dependency licensing. Initialize a fresh repository inside the reviewed output
only after these checks. Do not fetch or merge the old private history into it.

## Verify the public candidate

On Node 24, run `npm ci`, `npm run references:fetch`, and
`npm run dev:stack:check`. Confirm database integration tests actually run.
Render a report without installed brand images. The optional historical
migration tools require separately supplied private inputs, but ordinary app
development and tests do not. Downloaded references stay ignored in the new
repository. Publish source only until image redistribution is approved.

## Preparation verification (6 October 2026)

The cleanup passed a Node 24 Docker build with `npm ci`, typecheck, lint,
151 server tests with PostgreSQL enabled, 109 frontend tests, 57 domain tests,
18 operations tests, and production builds. No database tests were skipped.
The optional Python suite passed all 19 tests. `npm audit` reported zero
vulnerabilities and Gitleaks found no secrets in the source export. These are
point-in-time results, not a guarantee about future dependencies or commits.
GitHub Actions has been configured but has not yet run on GitHub.

The owner selected MIT and authorized a new public repository under
`UC-Motorsport`. The initial public commit uses the cleaned export and has no
parent from the original private repository. Production deployment and the
original private repository are separate from this public source release.
