# klippee

If you like this project, you can [support me here](https://ko-fi.com/tquinn)

Read the [Klippee documentation](https://cl-tim.github.io/klippee-web/).

Klippee stores, syncs, and shares Klipper printer configurations. It includes:

- Public config packages that people can browse, compare, fork, and reuse. A
  linked printer workspace serves the applied configuration its owner most
  recently reviewed and published. Later printer applies remain private until
  the owner explicitly reviews their exact files and republishes them.
- Private printer workspaces with a mutable draft for editing and a separate
  last-applied configuration established only by an explicit physical-printer
  `apply` or `capture`.
- Browser-based config editing with reviewable changes, recovery history, and
  target-aware printer configuration management.
- Focused Gridfinity, openGrid, and OpenGrid Underware component editors, plus
  stateless OpenSCAD and build123d reconstruction, 3D preview, and
  STL export.
- Local-first Klippy log diagnostics with failure classification, MCU and
  thermal telemetry, event timelines, and self-contained HTML reports.

The public site is [klippee.xyz](https://klippee.xyz). Browse community printer
configurations in [Shared Configs](https://klippee.xyz/shared-configs), or open
[shared Orca profiles](https://klippee.xyz/shared-configs?type=orca).

## Install

Start with the [Getting started guide](https://cl-tim.github.io/klippee-web/getting-started/). To self-host, download the Compose file, environment template and checksums from one [`selfhost-v*` release](https://github.com/cl-tim/klippee-web/releases), then follow the [self-hosting guide](https://cl-tim.github.io/klippee-web/operations/self-hosting/). From `selfhost-v0.1.4`, Compose pulls the prebuilt app and CAD images from GHCR; offline image archives are also available.

Browse the [full documentation](https://cl-tim.github.io/klippee-web/) or read it locally under [`docs/`](docs/).

## License

Klippee is licensed under GPL-2.0-or-later. Its native CAD container uses
OpenSCAD, build123d, and OpenCascade; see [NOTICE.md](NOTICE.md) and
[`server/CAD_NOTICE.md`](server/CAD_NOTICE.md).

## Development

For local setup and contribution instructions, see [Development](https://cl-tim.github.io/klippee-web/development/). The app uses Node.js, Vite, React, TypeScript, a Cloudflare Worker, and a Python CAD service.
