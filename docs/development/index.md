# Development

The public source repository is [`cl-tim/klippee-web`](https://github.com/cl-tim/klippee-web). The private `cl-tim/klippee` repository is retired; do not transfer private Git history.

## Local setup

Use Node.js 26 or Node.js 24.15 and later in the 24.x series. A fresh clone can use:

```bash
npm run setup:dev
npm run test:ui:smoke:install
npm run dev
```

`npm run setup:dev` installs npm packages, creates `.dev.vars` from `.dev.vars.example`, creates a local Python `.venv`, installs the CAD service dependencies, and applies local D1 migrations. Chromium is needed once for the startup check.

Run `npm run check` before submitting code. It runs linting, the license audit, production build, Worker smoke tests, UI guardrails, CLI tests, Python service tests, and the Cloudflare/Vite startup check in Chromium.

For the CAD API, run `npm run dev:cad` alongside `npm run dev`. It serves the stateless service on port 8791; each request uses temporary directories and does not use D1 or R2 ([CAD behavior](../guides/openscad.md)). Its container-parity commands are `npm run docker:cad:build` and `npm run docker:cad:run`. Wrangler deploys and dry runs that include `Dockerfile.cad` require Docker to be running; the Cloudflare Worker binds `/api/cad/*` to that container ([deployment guide](../operations/deployment.md)). When a local D1 error reports a missing table, apply migrations with `npm run db:migrate:local`.

For screenshot-based browser review, run `npm run test:ui:smoke:install` once, then `npm run test:ui:smoke`. The runner saves desktop and mobile screenshots plus browser-error reports under `artifacts/ui-smoke/`; see [UI visual QA](ui-visual-qa.md).

## Documentation site

The documentation is built with MkDocs from the pinned `requirements-docs.txt`. Install it with `python -m pip install -r requirements-docs.txt`, then run `python -m mkdocs serve` for local preview or `python -m mkdocs build --strict` to validate links and anchors. The GitHub Pages workflow builds the docs only; it does not build or deploy the application.

## Technical references

- [Architecture](architecture.md)
- [Configuration editor implementation](config-editor.md)
- [Web editing and history](web-editing-history.md)
- [UI components and theme](ui-components.md)
- [UI visual QA](ui-visual-qa.md)

### Dependency overrides

The ESLint dependency tree pins Minimatch to `11.0.3` for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The overrides target ESLint, `@eslint/config-array`, and `@typescript-eslint/typescript-estree`, which still require Minimatch 10. Remove them once all three resolve a patched version without overrides, then verify `npm audit` and `npm run check`. When changing this pin, also verify that ESLint still checks the same files and respects the configured ignore patterns.
