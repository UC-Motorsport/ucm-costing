# Web application

React, TypeScript and Vite frontend for UCM Costing. Run commands from the
repository root so npm resolves the shared `@ucm/domain` workspace.

Use `npm run dev:watch` for the complete API/database/frontend development
workflow. See the root [README](../../README.md) for setup and test logins.

Focused commands: `npm run typecheck -w @ucm/web`, `npm run lint -w @ucm/web`,
`npm test -w @ucm/web`, and `npm run build -w @ucm/web`.

Feature screens live in `src/features`, reusable controls in `src/components`,
and synthetic integration fixtures in `src/test`. The frontend uses shared
role keys; its login screen is not an individual-password identity system.
