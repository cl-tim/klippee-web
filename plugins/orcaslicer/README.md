# OrcaSlicer plugin development

For installation, pairing, and profile management, see
[Klippee for OrcaSlicer](../../docs/guides/orcaslicer-plugin.md).

- `klippee_plugin.py` and `klippee_plugin.html` implement the plugin.
- `capture_core.py` reads the current setup and profile library.
- `restore_core.py` validates exports and restores isolated copies.
- `npm run build` generates `public/install/klippee_orca.py`. Edit the plugin
  sources and regenerate the download when making changes.
- `npm run test:orca` exercises capture, restore, connection, and packaging
  behavior. Run `npm run check` for the full application checks.

Native probes in this directory can check the OrcaSlicer host APIs with
disposable profiles. See each probe's `--help` for its inputs. Keep probe output
under `artifacts/` because reports can contain preset names or local details.
