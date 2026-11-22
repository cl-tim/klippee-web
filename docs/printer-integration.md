# Printer Integration

Download the binary for your printer host or desktop from the
[hlab v0.3.0 release](https://github.com/cl-tim/hlab/releases/tag/v0.3.0).
Check it against `SHA256SUMS`. Save it as `hlab` (or `hlab.exe` on Windows),
make it executable on Linux or macOS, and put it on your PATH.
Existing connections can be reused. See the
[hlab Klippee guide](https://github.com/cl-tim/hlab/blob/v0.3.0/docs/klippee.md).

The native Go client manages one named printer target through explicit
configuration actions:

- `check` reports target identity and drift;
- `apply` installs one revalidated snapshot of the current pending draft or
  immutable target;
- `capture` chooses the current local files as authoritative;
- `recover` restores a cloud or local recovery point.

Klippee keeps the mutable pending draft separate from the physical printer's
last confirmed installed/applied version. Web editing and desktop capture do
not advance that applied record.

## Connect From a Printer Profile

From the selected printer's page, generate and run the private setup command:

```bash
KLIPPEE_BASE_URL=https://klippee.example.com \
  KLIPPEE_REPOSITORY_ID='repo-id' \
  KLIPPEE_TOKEN='sync-token' \
  KLIPPEE_CONFIG_DIR=$HOME/printer_data/config \
  hlab klippee init --printer --capture-current
```

The initial capture imports only the safe files reachable from `printer.cfg`.
Hidden files, backups, runtime state, credentials, and unreferenced config files
remain local.

Expected first commands:

```bash
hlab klippee target
hlab klippee check --diff
hlab klippee capture
hlab klippee apply
hlab klippee recover
hlab klippee variables list
hlab klippee query-box-reset-reason
hlab klippee upload-diagnostics
hlab klippee install-moonraker
hlab klippee install-timer
```

`hlab klippee target` should be the first troubleshooting command because it shows
the physical printer name and ID, service environment and URL, client role, and
configuration folder.

## Upgrading the Client and Agent

Install the verified hlab release at the current executable path. On an idle
printer, run `hlab klippee install-moonraker` to activate the agent. Existing
Python installations can use the same command after installing hlab. The
legacy endpoint remains available to existing installations during rollout.

## Applying Configuration

`hlab klippee apply` downloads and renders the current target for the bound printer.
If local files differ it:

1. prints the exact target and changed paths;
2. asks for confirmation;
3. refetches the target and aborts before writing if its content revision
   changed during review;
4. creates a local backup;
5. atomically replaces managed files;
6. reports the exact canonical template snapshot and revision used to render
   the installed files. The server creates or reuses an immutable version and
   advances the printer's applied pointer and `applied_at` timestamp; host-local
   variable values remain private on the client.

Use `hlab klippee apply --yes` only when the calling workflow has already made the
same explicit choice, such as an operator-triggered dashboard integration.

If the draft changes after the client selected its snapshot, Klippee records
the exact snapshot installed and leaves the newer draft pending. If cloud
confirmation fails, applied state does not advance. Apply never restarts
Klipper, so the applied record means “installed by the client,” not “accepted by
a later Klipper restart.”

A successful apply changes only the printer's authoritative applied record. It
does not update a linked public listing. Klippee shows the owner that the newer
applied configuration is unpublished until they review it and explicitly
republish from the browser.

## Capturing Printer Edits

When files were edited in Fluidd, Mainsail, or directly on the host:

```bash
hlab klippee check --diff
hlab klippee capture --note "Adjusted chamber fan macro"
```

Capture follows the actual Klipper include graph and reports excluded files. A
printer capture creates an immutable recovery point, clears the superseded
draft, and establishes those files as the last confirmed applied
configuration.

## Mainsail and Fluidd

Install the managed Moonraker-adjacent agent and dashboard macros:

```bash
hlab klippee install-moonraker
```

Restart Klipper once after installation. The dashboards then expose:

- `KLIPPEE_CHECK`
- `KLIPPEE_CAPTURE`
- `KLIPPEE_APPLY`
- `KLIPPEE_UPLOAD_DIAGNOSTICS`

The agent registers fixed Moonraker methods rather than exposing a general
shell command surface. It serializes actions and blocks apply or capture while
the printer is printing, paused, or its state is unknown. Before every apply or
capture request, including requests made through a compatibility alias, the
agent performs a fresh, bounded `print_stats.state` query over a separate local
Moonraker Unix-socket connection. The subscription cache is observational only:
query failures and unrecognized states fail closed, while recognized inactive
states allow the request to continue.

Automation should use `klippee_apply`, `klippee_capture`, and `klippee_check`.
Older installations may still call `klippee_pull`, `klippee_push`, and
`klippee_status`; the agent keeps those names as compatibility aliases for the
current apply, capture, and check operations. Legacy `klippee_pull` specifically
uses `apply --if-clean`: it requires a valid saved sync baseline and refuses to
replace any locally changed file. It never treats the old pull request as an
unconditional `apply --yes`. The aliases do not add legacy macros back to the
dashboard. Accepted alias calls identify their canonical command as `apply`,
`capture`, or `check`, so callers do not need to preserve the old verb names in
their status model.

An accepted action returns a unique `operation_id`. Automation can poll the
agent's `klippee_operation_status` method through Moonraker's extension request
endpoint for `running`, `current`, and `last_result`. Supplying the optional
`operation_id` returns only a matching current or last result, with `found`
indicating whether that result is still available. This status method is not
registered as a Klipper remote method and has no G-code macro. The records
include the operation ID, canonical command, timestamps, completion status,
return code, and a bounded output summary. The QIDI Box reset-reason operation
also preserves its validated JSON result in the exact operation record.

### QIDI Box reset reason

`hlab klippee query-box-reset-reason` is a printer-only incident-response command
for the analyzed QIDI Box 1.1.1 firmware. It runs only when a fresh structured
Moonraker query reports Klippy in `shutdown`, and it takes the `mcu_box1`
serial endpoint from Moonraker's loaded `configfile.settings`; there is no path
argument or environment override.

The command fails closed unless the endpoint is the expected QIDI Box USB
device, no other live process owns its current tty, the serial session opens
exclusively, and the runtime MCU version and canonical command dictionary match
the analyzed firmware. It keeps the port at 250000 baud, never touches the
1200-baud bootloader trigger, sends no STK500 leave bytes, does not start clock
synchronization, and sends only Klipper's identify exchange followed by one
fixed 32-bit read of STM32 register `RCC_CSR` at `0x40023874` and one
`reset_reason_get` request with a dedicated response-correlation OID. The
register address and width are compiled into the client; this is not an
arbitrary memory-read interface. It does not reset the MCU, clear the reset
flags, change configuration, restart Klipper, or run G-code.

Successful output is one compact `klippee-box-reset-reason/v2` JSON object.
The result records the endpoint identity, explicit safety preconditions, raw
`RCC_CSR` value, and every asserted reset-cause bit, including brownout. Treat
the flags as evidence, not certainty: they remain sticky until firmware writes
the `RMVF` clear bit, and this query intentionally does not do so. Run it before
any `FIRMWARE_RESTART`; a command restart adds the `Software` flag to the
retained evidence. The vendor's string decoder reports only its first matching
flag and ignores brownout, while the raw result preserves combinations such as
`IndependentWatchdog` plus `Brownout` for correlation with USB and power
evidence.

Automation should invoke the agent method
`klippee_query_box_reset_reason`, retain the returned `operation_id`, and poll
`klippee_operation_status` for that exact ID. The completed record exposes the
same structured object as `last_result.result`. This method intentionally has
no G-code macro because Klippy is unavailable in the required shutdown state.

Normal dashboard results are returned through Klipper's `RESPOND` command and
the service journal. The shutdown-only Box query writes only to the service
journal and its structured operation result:

```bash
journalctl --user -u klippee-moonraker.service -f
```

Re-running `hlab klippee install-moonraker` refreshes the managed service and macro
file without duplicating the include in `printer.cfg`.

For periodic status checks, run:

```bash
hlab klippee install-timer
```

The resulting user timer runs `hlab klippee check` every ten minutes. It is
read-only: it never invokes `apply`, changes printer files, or marks a draft as
applied.

## Desktop Workspace

The generated desktop setup command installs the same client in desktop mode
and immediately applies the current printer target to the current folder. This
records the target's content revision as the workspace baseline.

The normal IDE loop is:

```bash
hlab klippee target
hlab klippee check --diff
hlab klippee capture --note "Edited in VS Code"
```

Use `hlab klippee apply` when the current printer target should replace the desktop
folder. Desktop apply creates a local backup but never updates the physical
printer's applied state.

Desktop `capture` stages the local files as the mutable pending draft; it does
not create an immutable version or update the physical printer. The client
sends its saved baseline revision, and the server rejects the capture with a
conflict if the web editor or another desktop changed the target since this
workspace synchronized. Run `hlab klippee check --diff` before deciding whether to
apply the newer target or retry capture after synchronizing.

Desktop workspace connection state lives in that folder's `.klippee`
directory, so separate folders can safely connect to separate printer targets.

## Host Reporting

After a physical-printer apply or capture, the client reports the applied
version and timestamp, then reports this host information as a best-effort
follow-up:

- OS name;
- kernel and architecture;
- hostname;
- Klippee client version;
- Klipper version and state when available;
- Moonraker version when available.

Host reporting is best effort and never turns a successful configuration action
into a failure. It includes no file contents or credentials.

## Diagnostics

`hlab klippee upload-diagnostics [path]` creates a private, expiring ZIP bundle with
the selected Klippy log plus available Moonraker logs, bounded journal
excerpts, resolved runtime state, temperatures, recent G-code, job history, and
host information. It also includes a bounded USB serial topology snapshot so
kernel disconnects can be matched to configured MCU paths without later SSH
access. When the printer exposes `save_variables`, the bundle includes only a
strict, typed allowlist of non-secret QIDI Box state used for incident analysis
(for example automatic RFID/loading flags and slot state). All other persisted
variables and their names are omitted; the snapshot records only how many were
left out.

Uploads are private to the printer owner, expire after 48 hours, and are
limited to the newest five per printer.

## Recovery

List recovery points:

```bash
hlab klippee recover
```

Restore a cloud recovery point and apply it on the physical printer:

```bash
hlab klippee recover cloud:<id>
```

Restore a local pre-apply backup:

```bash
hlab klippee recover local:<name>
```

Cloud recovery is restricted to the physical-printer client. Local recovery is
available wherever a backup exists.

## Safety Rules

The integration must always:

- identify the service, target, role, and folder before mutation;
- show changed paths before replacing local files;
- require confirmation or explicit `--yes`;
- create a backup before replacement;
- block unresolved variables;
- exclude credentials and runtime state from capture;
- block hardware-side actions while printing;
- leave Klipper restart under operator control.
