# Agent Notes

Read the [README](README.md) for a project summary and install links, and use [`docs/index.md`](docs/index.md) to navigate the version-specific documentation in this checkout.

## Project Shape

Klippee is a mixed Vite/React, Cloudflare Worker, and Python FastAPI project.

- Frontend: `src/`, Vite, React, TypeScript.
- Worker API: `worker/index.ts`, Cloudflare D1/R2 bindings, static assets from
  `dist/client` (the `@cloudflare/vite-plugin` build also writes the Worker
  bundle and a generated deploy config to `dist/klippee`; see
  `docs/operations/deployment.md` section 9).
- CAD service: `server/`, FastAPI, packaged by `Dockerfile.cad` for Cloudflare Containers.
- Smoke and guardrail tests live in `tests/` and `scripts/`: Worker API smoke
  tests in `tests/worker/*.test.mjs`, CLI tests in `tests/cli/*.test.mjs`
  (both run with `node --test`); Python service tests live in `server/tests/`.
- TypeScript is a three-project build: `tsconfig.app.json` (src),
  `tsconfig.node.json` (config files), and `tsconfig.worker.json` (worker/
  against the generated `worker-configuration.d.ts`). `tsc -b` from
  `npm run build` checks all three.
- `react-aria-components` is used only for the workspace file-browser Tree
  (`src/features/workflows/components/`). That is by design — do not spread it
  to other UI surfaces, and do not remove it as "mostly unused".
- The printer CLI `public/install/klippee.py` must stay runnable on
  Python 3.7 (see `docs/guides/printer-integration.md`): no walrus operator (`:=`),
  no `match` statements, no other 3.8+-only syntax or stdlib.

## Local Development

On current `main`, the documented baseline is:

```bash
npm install
python -m pip install -r server/cad-requirements.txt
npm run test:ui:smoke:install
npm run check
```

For CAD API testing, run the Python service alongside Vite:

```bash
npm run dev:cad
npm run dev
```

When using Wrangler locally, copy `.dev.vars.example` to `.dev.vars`; never commit `.dev.vars`.

Prefer `npm run setup:dev` for fresh clones. It creates a repo-local Python `.venv`, copies `.dev.vars.example` when needed, installs CAD dependencies, and applies local D1 migrations.

## Verification

The strongest local gate is:

```bash
npm run check
```

It runs lint, license audit, production build, CLI tests, UI guardrails, Worker API smoke tests, Python CAD tests, and the real Cloudflare/Vite startup check in Chromium.

TypeScript 6 / current DOM typings may reject `Uint8Array<ArrayBufferLike>` as a `BlobPart`. Convert binary bytes to a plain `ArrayBuffer` at `Blob` boundaries.

## npm Overrides

`package.json` overrides Miniflare's `undici` with `7.30.1` to address the
current Undici advisories. The Cloudflare Vite plugin still requires a
Miniflare release that pins `7.29.1`. Remove this override once every resolved
Miniflare release requires Undici >= 7.30.1. Check `npm ls undici` and
`npm audit` after each Wrangler or Cloudflare Vite plugin update.

The Sharp and ws overrides are no longer required. Upstream dependencies now
resolve patched versions without those overrides.

After removing any override: run `npm install`, then `npm audit` and
`npm run check` must both stay clean before committing the removal.

## Public source and releases

Develop and push changes in `cl-tim/klippee-web`, the active repository. The
private `cl-tim/klippee` repository is retired and archived. Never transfer its
private Git history into this repository.

Keep product guides, operator instructions, contributor documentation, and
license notices in the public tree. When importing reviewed source, preserve
these public guides and exclude internal plans, historical QA reports, and
private publication notes.

Run `npm run publication:check` before publishing a source snapshot. Use
synthetic printer fixtures and keep personal printer captures, site credentials,
and probe output out of Git.

The tag-only release workflow publishes Docker Compose files and downloadable
app and CAD images. Run `npm run check` before creating a `selfhost-v*` tag.
See [Self-hosting](docs/operations/self-hosting.md) for installation and
[Cloudflare deployment](docs/operations/deployment.md) for operating a Cloudflare instance.
