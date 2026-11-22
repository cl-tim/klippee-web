# Configuration Sync Behavior

Klippee keeps a mutable pending draft and the printer's last confirmed applied
configuration as separate states. The normal workflow is intentionally not
presented as version control: operators choose whether the current printer
target or the local files should win.

Editing or desktop capture updates the draft; neither action claims that the
printer changed. Only an explicit `apply` or `capture` performed with a
physical-printer credential advances the applied record. Immutable snapshots
exist behind the scenes for recovery, but snapshot identifiers and repository
mechanics are not part of the everyday workflow.

The web editor is the primary authoring surface and autosaves into the pending
draft. If that printer workspace has a Shared Configs listing, the listing
continues to serve its last owner-approved snapshot while the draft is pending.
A physical apply or capture advances the printer's applied record but does not
publish it. Klippee marks that newer applied configuration as unpublished for
the owner until they explicitly review and republish it.

## Mental Model

Every installed client has four pieces of identity:

- **Service**: the Klippee installation, labelled as production, staging, or
  local and shown with its full URL.
- **Target**: the printer name and stable printer ID.
- **Role**: either a physical printer or a desktop workspace.
- **Folder**: the local configuration directory being read or changed.

Every command that can change configuration prints this identity before it
acts. A physical-printer installation is pinned to one target.

Each target also has two configuration states:

- **Pending draft**: the mutable files most recently autosaved by the web
  editor or captured from a synchronized desktop workspace. This is the next
  target offered to clients, not evidence of what the printer is using.
- **Last applied**: the immutable version and timestamp most recently confirmed
  by the physical printer after `apply` or `capture`. This is the sole cloud
  record of what Klippee installed on that printer. There is no separate
  known-good pin.

## Commands

```text
hlab klippee target
hlab klippee check [--diff]
hlab klippee apply [--yes|--if-clean]
hlab klippee capture [--note "text"]
hlab klippee recover [cloud:<id>|local:<name>]
hlab klippee variables list|set|unset|doctor
hlab klippee upload-diagnostics [klippy.log path]
hlab klippee install-moonraker
hlab klippee install-timer
```

There are no direction-based transport commands and no force mode. `apply` and
`capture` state explicitly which side is authoritative.

Despite its historical name, `hlab klippee install-timer` installs a read-only
systemd user timer. The timer runs `hlab klippee check` every ten minutes; it never
runs `apply`, writes configuration files, or advances cloud state.

## Target

`hlab klippee target` verifies the installed connection without displaying its
credential:

```text
Target:  Workshop QIDI (printer_abc123)
Service: production — https://klippee.example.com
Role:    physical printer
Folder:  /home/mks/printer_data/config
```

The service label is derived from the configured URL. Localhost and `.local`
hosts are labelled local; development, preview, and staging hostnames are
labelled staging; other hosts are labelled production.

## Check

`hlab klippee check` compares the rendered current target (the pending draft when
one exists, otherwise the newest immutable target) with the local files. It
reports:

- the exact target identity;
- whether the target is current;
- paths that would be added, updated, or removed;
- whether the local workspace, remote target, or both have changed since the
  saved content-revision baseline;
- the explicit next choices: apply the printer target or capture local files.

`hlab klippee check --diff` also prints unified file diffs. Generated Beacon models
and bed mesh profiles in Klipper's `SAVE_CONFIG` block are ignored so ordinary
calibration does not appear as configuration drift.

Checks render `${KLIPPEE:name}` placeholders with the selected printer profile
and host-local variable file before comparing. A missing required value stops
the check with the exact variable names that must be configured.

`check` is read-only. This makes it safe for the managed timer and for routine
status polling.

## Apply

`hlab klippee apply` makes the local folder match one exact snapshot of the current
printer target.

Flow:

1. Load the target identity, files, and content revision.
2. Show every path that would be added, updated, or removed.
3. If local files differ, require confirmation in an interactive terminal.
4. For unattended operation, require the explicit `--yes` option.
5. Fetch the target again after review and abort before writing if its revision
   or files changed.
6. Create a timestamped local backup.
7. Atomically write target files and remove previously managed files that are
   no longer part of that target.
8. Record the exact local content baseline and revision.
9. On a physical printer, report the exact canonical template snapshot and
   revision used to render the installed files. The server creates or reuses an
   immutable version and advances only that printer's applied pointer and
   timestamp. Host-local variable values remain on the client.
10. Report host software details as a best-effort follow-up.

The pending draft is cleared only when the installed revision still matches
it. If a newer edit arrived after installation, the applied record still names
the exact installed files and the newer draft remains available. If cloud
confirmation fails, the command reports failure and the server does not advance
applied state.

Klippee never restarts Klipper automatically. “Applied” here means that the
physical client installed and reported the files; it does not claim that a
later Klipper restart parsed them successfully. After an apply changes files,
the client reminds the operator to restart Klipper when ready.

`apply --yes` is an affirmative application choice, not a conflict bypass. It
has the same backup and validation behavior as interactive apply.

`apply --if-clean` is the noninteractive compatibility path used by the legacy
Moonraker `klippee_pull` method. It requires valid `last-sync` metadata and a
valid checksum manifest, refuses every local file change since that baseline,
checks the baseline again immediately before mutation, and never prompts. A
missing, corrupt, or dirty baseline requires an explicit reviewed apply or
capture instead.

Desktop apply changes only that desktop folder. It never claims that the
physical printer applied the configuration.

## Capture

`hlab klippee capture` deliberately chooses the current local files as authoritative.

Flow:

1. Print the target, service, role, and local folder.
2. Walk the include graph starting from `printer.cfg`.
3. Exclude unreferenced, hidden, runtime, backup, and credential-shaped files.
4. Restore variable placeholders where the local file was rendered from a
   stored client template. As a fallback, the server uses the exact desired
   baseline or applied snapshot and restores only the matching option or
   command occurrence in the same Klipper section. Ambiguous, moved, missing,
   duplicated, or renamed template paths fail closed.
5. Read the saved server content revision for conflict protection.
6. Mark the local files as the current baseline only after the server accepts
   the request.

Capture notes are optional:

```text
hlab klippee capture
hlab klippee capture --note "Tune input shaper"
```

A physical-printer capture stores an immutable version, clears any superseded
pending draft, and marks that version as the printer's last applied
configuration. A desktop capture only replaces the mutable pending draft. It
does not create an immutable version or change printer/public state.

Desktop capture supplies the revision saved by its previous apply or capture.
If the web editor or another desktop changed the target in the meantime, the
server returns a conflict and changes neither the draft nor the local baseline.
Run `hlab klippee check --diff`, then synchronize before choosing which side wins.

If a missing or outdated template sidecar would cause a host-local variable
value to be uploaded as a literal, the server rejects the capture. Run a
reviewed `hlab klippee apply` with the current client to rebuild the sidecar, then
capture again. This keeps host-local secrets out of repository history.

Normal capture output never prints configuration or G-code bodies.

## Recovery

`hlab klippee recover` lists cloud and local recovery points:

```text
Cloud recovery points:
  pending draft (desired; choose a cloud recovery point to replace it)
  cloud:7 (applied, latest saved; selecting cancels draft)  2026-07-29 09:45:00  Tune input shaper
  cloud:6                                               2026-07-28 18:10:00  Previous configuration
Local recovery points:
  local:manual-20260729-094500
```

Recover an older cloud point on the physical printer:

```text
hlab klippee recover cloud:6
```

Klippee creates a recovery target from that point, then applies it with the
normal revision check, backup, and physical confirmation rules. The printer's
applied pointer stays on the previous version until that apply succeeds. Any
linked public listing stays on its last owner-approved snapshot both before and
after the apply, until the owner explicitly republishes the recovered version.

When a pending draft exists, selecting the newest saved cloud point is also a
valid recovery action. It compare-and-swap clears only the draft that was
listed and reuses the saved version, so cancelling a bad draft does not add a
duplicate recovery point.

Recover a local backup:

```text
hlab klippee recover local:manual-20260729-094500
```

Local recovery backs up the current files first and does not change the cloud
draft or applied record. Run `hlab klippee check` afterward to decide whether to
capture the recovered files or reapply the current printer target.

## Local State

Printer clients keep private connection settings in the user's state directory.
Desktop workspaces keep their connection beside the workspace so different
folders can target different printers:

```text
~/.klippee/
  config.json

~/printer_data/config/
  klippee_variables.cfg
  .klippee/
    last-sync
    last-sync-files
    variable-templates.json
    backups/

~/desktop-printer-config/
  klippee_variables.cfg
  .klippee/
    config.json
    last-sync
    last-sync-files
    variable-templates.json
    backups/
```

Connection credentials and host-local variables are never printed by target
inspection and are not included by capture.

## Variables

Per-printer values are stored in the visible local
`klippee_variables.cfg` file:

```text
# KLIPPEE_VARIABLE beacon_serial=/dev/serial/by-id/usb-Beacon_...
```

The file is all comments so broad Klipper include patterns remain safe. It is
never captured. Host-local values override non-secret values stored in the
printer profile, allowing secret values to remain on the printer.

Apply and check stop before changing anything when a required placeholder is
unresolved.

## Conflict Handling

Klippee does not merge Klipper files or guess intent. Every synchronized
workspace records the content revision it last received.

When local and target contents differ:

- `check` explains the drift;
- `apply` chooses one revalidated target snapshot;
- `capture` chooses local configuration, subject to the saved baseline;
- `recover` restores a known earlier state.

When both the server revision and local files changed, `check` reports a
divergence. Desktop capture returns `409` instead of overwriting the newer
draft. Physical apply refetches the target after review and aborts if it moved.
Backups make each local replacement reversible, while cloud recovery points
preserve earlier immutable states.

## Limits and Safety

Capture accepts at most 64 safe configuration files and 256,000 bytes per file.
Both client and server enforce these limits.

A repository retains at most 256 immutable versions and accepts at most 16
active sync tokens. The server returns HTTP `409` with
`code=storage_quota_exceeded` when either collection is full. Delete an
unneeded version or revoke an old token before retrying. The last version and a
version confirmed as applied on a printer remain protected from deletion.

The include-graph scan excludes:

- credentials, tokens, and secret-shaped paths;
- `saved_variables.cfg` and other runtime state;
- dated `SAVE_CONFIG` snapshots;
- `.klippee` state and backup directories;
- files not loaded from `printer.cfg`.

The Moonraker integration blocks apply and capture while a printer is printing,
paused, or its state is unknown. Canonical methods and compatibility aliases
make a fresh, bounded `print_stats.state` query over a separate local Moonraker
Unix-socket connection before accepting either mutation. Cached subscription
state is observational only; failed queries and unrecognized states fail
closed.

## API Credentials

Printer clients use narrowly scoped printer-bound sync tokens rather than
browser sessions. Desktop tokens are also bound to the selected printer but
cannot report a configuration as applied to physical hardware.

Recommended scopes remain:

- `repo:read`
- `repo:write`

Public package publication is a separate authenticated browser action. A
linked listing stores the explicit printer identity, an owner-approved version
identifier, and a sanitized public snapshot. Anonymous catalog, detail, preview,
and download requests serve that snapshot rather than following the printer's
current applied pointer. Publishing requires at least one applied version;
drafts never become public merely because they autosaved.

Printer-bound sync credentials can report what the physical machine applied,
but cannot publish it. When that applied version differs from the approved
version, the owner-only publication status reports it as unpublished. An
authenticated owner must explicitly review the exact applied publication
candidate and republish it before the public snapshot changes. The approval
request is pinned to that candidate's immutable version ID, so a concurrent
printer report cannot substitute different files. Editing listing metadata does
not approve files.

Existing linked listings created before approval provenance was recorded keep
serving their stored snapshots. Their owners must republish once to associate
the snapshot with an exact approved version.
