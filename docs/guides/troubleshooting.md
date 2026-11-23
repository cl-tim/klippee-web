# Troubleshooting
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

## Troubleshooting

### `klippee` is not recognised

Open a new terminal after setup. If it is still unavailable, add the install
directory reported by the installer to `PATH`.

### Apply asks before replacing files

Run `hlab klippee check --diff`, then choose `hlab klippee capture` to keep the local
files or `hlab klippee apply` to use the revalidated printer target. Unattended
workflows use `hlab klippee apply --yes` only after making that explicit choice.

### Desktop capture reports a baseline conflict

The target changed after this desktop last synchronized, so Klippee left both
the cloud draft and local baseline untouched. Run `hlab klippee check --diff`, use
`hlab klippee apply` if the newer target should win, or synchronize before retrying
capture when the desktop files should win.

### A pulled file still contains `${KLIPPEE:name}`

Run:

```bash
hlab klippee variables doctor
hlab klippee variables set name value
hlab klippee check --diff
```

### A referenced config is missing after capture

Confirm the file is reachable from `printer.cfg` through an active
`[include ...]` line. Include paths are resolved relative to the file containing
the include. Review the client's skipped-file list for spelling, backup naming,
or sensitive-file exclusions.

### Host information is unavailable

Sync still succeeds because host reporting is best-effort. Run
`hlab klippee target`, confirm the configured base URL and token are current, and use
the HTTP status and response body printed by the client to diagnose the API.

### Diagnostics upload fails

Retry with an explicit Klippy log path:

```bash
hlab klippee upload-diagnostics ~/printer_data/logs/klippy.log
```

The client prints the HTTP status and server response when the upload is
rejected.

### A storage limit is reached

Klippee returns a specific `Storage limit reached...` message instead of
silently replacing data. Remove an unneeded version or printer, or revoke an old
sync token, then retry. Repositories, private packages, and companion assets do
not yet have self-service deletion: reuse or edit an existing item, or contact
the site operator to archive it. A repository keeps up to 256 versions and 16
sync tokens; the cloud workspace also keeps bounded collections of repositories,
printers, packages, and assets. Existing printers, packages, and assets can
still be edited while their collection is full. Unique cloud file bodies also
have a cumulative 512 MiB claim budget per account; saving identical content
again does not consume more of that budget.

Version messages are limited to 512 UTF-8 bytes. Custom version-source labels
and file roles are limited to 64 UTF-8 bytes, and config paths to 180 UTF-8
bytes. Printer IDs use at most 128 ASCII letters, numbers, dots, underscores,
or hyphens, while printer names use at most 256 UTF-8 bytes. Shorten the
rejected field and retry if the editor or sync client shows one of these
validation errors.
