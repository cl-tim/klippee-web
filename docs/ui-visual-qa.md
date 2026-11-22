# UI Visual QA

Use this checklist after frontend changes that affect app navigation, login,
configuration, workspace editing, package browsing, sync, or CAD tools.

## Repeatable Checks

Run:

```bash
npm run test:ui
npm run check
```

`test:ui` guards the expected public/private navigation split, login modal
semantics and layering, editor/package/CAD surfaces, and responsive breakpoint
coverage.

`npm run check` also runs `npm run test:dev`. This starts the real Cloudflare
Vite configuration and checks that the default sign-in page and OpenSCAD source
panel mount under the Worker's actual security headers. Anonymous API fixtures
keep the developer's local account data out of the check. It verifies fresh
response nonces, React refresh, the hot-reload connection and rejection of
unmarked inline scripts. Chromium must be installed with
`npm run test:ui:smoke:install` before running this gate for the first time.

To run just this check, use `npm run test:dev`. To reuse an already-running
loopback Vite server, set `KLIPPEE_DEV_SMOKE_URL` to its URL. The general visual
smoke runner below uses a frontend-only server with API fixtures and does not
exercise the Worker's security policy.

## Automated Browser Screenshots

Install Chromium once, then run the visual smoke pass:

```bash
npm run test:ui:smoke:install
npm run test:ui:smoke
```

The runner starts a local Vite server, uses deterministic anonymous and signed-in
API fixtures, and captures desktop (`1440 x 1000`) and mobile (`390 x 844`)
screenshots. It covers every primary workspace, the login and package dialogs,
printer setup, installation, editor, profile, Shared Configs, and OpenSCAD Studio
surfaces.

Each run writes `report.md`, `report.json`, and PNGs beneath a timestamped
`artifacts/ui-smoke/` directory. The report records console errors and warnings,
uncaught page errors, failed requests, and HTTP responses with status 400 or
higher. Browser errors make the command fail after all artifacts have been
written. Set `UI_SMOKE_ALLOW_ERRORS=1` only when intentionally collecting a
known-broken baseline.

To test an already-running or deployed target instead of starting Vite:

```bash
UI_SMOKE_BASE_URL=https://example.test npm run test:ui:smoke
```

## Manual Browser Pass

Check these widths:

- Desktop: `1280 x 720`
- Tablet: `900 x 900`
- Mobile: `390 x 844`

At each width:

- Anonymous state can access Shared Configs, Log Diagnostics, and OpenSCAD Studio; protected
  account workspaces show the sign-in gate.
- Protected workspace/editor/package/sync surfaces show the auth-required panel
  instead of private state.
- Login modal appears above the app, traps the visual focus, and exposes GitHub,
  Discord, and close controls.
- Setup auth gate text fits without overlapping controls.
- OpenSCAD Studio shows source files, source editor, 3D preview, quality controls,
  detected parameters, and STL generation actions without loading WASM until
  Generate is selected.
- Log Diagnostics shows the local-only file surface without authentication. An
  analyzed log keeps findings, timeline, MCU, thermal, replace, clear, and HTML
  export controls usable without horizontal overflow.
- Package and variable panels avoid horizontal overflow.
- Editor panes preserve stable dimensions and do not collapse while loading.
