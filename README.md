# UCM Costing

A costing and report-generation app for University of Canterbury Motorsport.
Manage bills of materials, calculate part costs, attach drawings, and export
Formula SAE-A cost reports.

## Run locally

Requires Node.js 24 and Docker with Compose.

```sh
git clone https://github.com/UC-Motorsport/ucm-costing.git
cd ucm-costing
npm ci
npm run references:fetch
npm run dev:stack
```

Open http://127.0.0.1:8080. For the local development login, use
`test@localhost.invalid` with key `admin-test`.

## Development

For hot reload, run `npm run dev:watch` and open http://127.0.0.1:5173.

```sh
npm run dev:stack:check  # typecheck, lint, tests, and build
npm run dev:stack:stop   # stop the local stack
```

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Architecture](ARCHITECTURE.md)
- [Deployment](docs/operations/DEPLOYMENT.md)
- [Backup and restore](docs/operations/BACKUP_AND_RESTORE.md)

## License

[MIT](LICENSE).
