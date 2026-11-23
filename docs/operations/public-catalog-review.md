# Public Catalog Review

Use this checklist before publishing, republishing a newer printer-applied
configuration, or promoting a public package for launch validation. A printer
apply remains private until the owner completes this review and explicitly
republishes it.

## Required Package Shape

- Name, title, description, printer, hardware tags, and human-readable version
  are present.
- Every file has a normalized relative path, role, content, and `public: true`.
- `variables` exists, even when empty.
- `warnings` exists, even when empty.
- Version names are readable by humans, such as `2026.05.19`, `1.0.0`, or
  `klipper-v0.13-qidi-box`.

## Safety Review

- Publishing safety scan has no blocking findings.
- Warning-only findings are either fixed or explicitly acknowledged.
- Machine-specific values use `${KLIPPEE:name}` variables instead of resolved
  serial paths, local hostnames, static IPs, CAN UUIDs, passwords, or tokens.
- Runtime files are absent: `saved_variables.cfg`, `.klippee/*`,
  `moonraker.secrets`, generated mesh/state files, and macro output files.
- Backup, archive, and log files are absent: `*.bak`, `*.bkp`, `*.zip`,
  `*.tar*`, `*.7z`, `*.rar`, and `*.log`.

## Launch Validation

After production contains at least one reviewed public package, run:

```bash
KLIPPEE_REQUIRE_PUBLIC_PACKAGE=1 npm run smoke:prod
```

For launch promotion, run:

```bash
npm run launch:verify
```

The public package smoke path verifies that the catalog includes a renderable
package, that preview rendering completes, that ZIP download returns a valid ZIP,
and that the selected package does not expose private metadata, runtime files,
backup/archive files, or resolved `/dev/serial/by-id/...` values.
