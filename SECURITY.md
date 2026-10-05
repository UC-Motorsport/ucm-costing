# Security

## Reporting a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/UC-Motorsport/ucm-costing/security/advisories/new) if it is available. If it is unavailable, ask the maintainer
for a private reporting channel without posting exploit details or sensitive
data in a public issue.

Include the affected revision, a minimal synthetic reproduction, impact, and
any suggested fix. Do not attach production credentials, personal records,
team data, or database backups. There is no guaranteed response time or
supported-release window yet; fixes target the current maintained branch.

## Deployment model

This application is intended for a trusted team behind HTTPS and appropriate
network access controls. Access keys are shared within each role. A key holder
can claim any known active email in that role, so recorded audit identities
are not individual cryptographic authentication. Deployments requiring
individual identity assurance need a different authentication design.

Generate fresh production secrets with `npm run env:init -- https://your-host.example`.
Development keys are public test fixtures and must never be used in production.
Keep the database off public networks, retain encrypted off-host backups, and
follow the deployment and recovery runbooks. Do not enable weak access keys or
insecure HTTP unless the documented independent protection requirements apply.
