# Klippee user guide

This guide explains the normal Klippee workflow: create a printer, manage its
Klipper configuration, keep the browser and printer in sync, and diagnose
failed prints.

> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

## Contents

- [Start here](#start-here)
- [Create a printer](#create-a-printer)
- [Edit configuration files](#edit-configuration-files)
- [Turn a value into a variable](#turn-a-value-into-a-variable)
- [Draft, apply, and recover configurations](#draft-apply-and-recover-configurations)
- [Delete an old saved configuration](#delete-an-old-saved-configuration)
- [Link a physical printer](#link-a-physical-printer)
- [Manage configuration from the command line](#manage-configuration-from-the-command-line)
- [Edit in a desktop IDE](#edit-in-a-desktop-ide)
- [Add Mainsail or Fluidd actions](#add-mainsail-or-fluidd-actions)
- [Use Shared Configs](#use-shared-configs)
- [Diagnose a Klippy log](#diagnose-a-klippy-log)
- [Create filament and slicer profiles](#create-filament-and-slicer-profiles)
- [Generate parametric CAD components](#generate-parametric-cad-components)
- [Troubleshooting](#troubleshooting)

## Start here

1. Open [klippee.xyz](https://klippee.xyz) and sign in.
2. Open **Klipper Workspace** in the navigation.
3. Create a printer or select an existing one.
4. Import the printer's current files before replacing a working configuration.
5. Make and review changes in the autosaved workspace draft.
6. Open **Printers** and explicitly apply the draft when it is ready for the
   physical machine.

The workspace has three main areas:

- **Printer and Configuration Files** on the left select the active printer and
  file.
- The editor in the centre holds an autosaved working draft.
- **Workspace tools** below the editor contains Review, Docs, Package,
  Variables, Versions, and Install actions.

## Create a printer

1. Open **Klipper Workspace** or **Printers**.
2. Choose the **+** button beside Printer.
3. Select a starter that matches the printer's kinematics, or choose a custom
   printer when you will import an existing configuration.
4. Enter a recognisable printer name and description.
5. Confirm the new printer.

A starter creates an editable draft with example files and variables. It does
not connect to hardware, create applied history, or claim that a printer uses
those files.

## Edit configuration files

### Open, create, rename, or remove a file

- Select a file in **Configuration Files** to open it.
- Enter a path such as `macros/start_print.cfg` and choose **Create** to add a
  file in a subfolder.
- Use the pencil beside a file to rename it.
- Use the bin beside a file to remove it from the draft.
- Use the upload action to import one or more `.cfg` files. Create a subfolder
  path explicitly when its relative path matters.

Klippee keeps edits as a browser draft while you move between files. The
timestamp beneath the editor confirms when the draft was last autosaved.
For a linked cloud workspace, autosave also stages the complete file set as one
mutable pending draft. Autosave is not applied history: it does not change the
printer's last confirmed configuration or a linked public listing.

### Review before applying

Open **Workspace tools → Review** to check:

- changed files and the proposed diff;
- missing `[include ...]` targets;
- unresolved variables;
- lint and safety findings.

Warnings are prompts to inspect the configuration. Blocking findings must be
resolved before a package can be installed or downloaded.

## Turn a value into a variable

Variables let one reusable configuration render different machine-specific
values for each printer.

1. In the editor, select the literal value you want to vary. You may select the
   entire `name: value` or `name = value` line; Klippee isolates its value and
   preserves any trailing comment.
2. Choose **Make variable** in the editor selection action.
3. Review the suggested variable name and placeholder.
4. Choose **Convert value**.
5. Open **Workspace tools → Variables** and confirm the value for the active
   printer.
6. Review the configuration when the rendered result is correct; it remains an
   autosaved draft until the physical printer applies or captures it.

Only the selected occurrence is converted. Klippee replaces it with
`${KLIPPEE:variable_name}` and uses the old non-secret literal as that
printer's initial value.

Secret values are deliberately not seeded into the browser profile. Set one on
the printer host instead:

```bash
hlab klippee variables set variable_name value
hlab klippee variables doctor
```

Use `hlab klippee variables list` to see the values available to the client. Check
and apply render placeholders with the selected printer's values before
comparing files.

## Draft, apply, and recover configurations

To prepare a printer update:

1. Finish edits across all affected files.
2. Review the warnings and diff.
3. Wait for the editor's autosave status. The **Printers** page will show that a
   draft is available.
4. On the physical printer, run `hlab klippee check --diff`, review the exact target,
   then run `hlab klippee apply`.

The web draft is mutable and is not an applied record. Physical apply fetches
the target again after review, renders and writes one exact target snapshot,
then reports that canonical snapshot and revision. Host-local variable values
stay on the client. A physical `hlab klippee capture` can instead choose the
printer's current local files as authoritative. Either successful physical
operation establishes the last confirmed installed/applied version and time.
There is no separate known-good pin.

Open **Workspace tools → Recovery** to inspect saved recovery points.

Recovery labels distinguish the newest immutable repository target from
**Applied**, the configuration last reported by the physical printer client.
Newest does not imply applied, and a pending editor draft is not an immutable
recovery point.

Select a recovery point to view its changes relative to the previous point. To
restore it, run the displayed `hlab klippee recover cloud:<id>` command on the
physical printer. Recovery preserves the audit trail. Deleting a recovery point
requires confirmation, at least one point must remain, and the last confirmed
applied point cannot be deleted.

## Delete an old saved configuration

Open **Printers → Saved configurations** to see your saved cloud configurations,
including ones no longer linked to a printer. Choose **Delete**, review the
configuration name, and confirm **Delete saved configuration**. This permanently
removes its saved draft, all recovery versions, associated diagnostic uploads,
and cloud sync access. It does not contact printers or change their files.

A configuration still linked to a printer or public listing cannot be deleted.
Remove those links in Klippee first. History used by another configuration is
also protected. If the configuration changes while the list is open, refresh
and review it again before deleting. Deleting a cloud copy does not remove
independent browser drafts, downloaded backups, or separately saved packages.

## Link a physical printer

Linking connects hlab to one printer. The token can access only that printer's
private configuration repository. Install hlab with the `klippee` command group
on the printer host first.

1. Open **Printers** and select the printer.
2. In **Link printer**, choose **Create import token**.
3. Copy the generated command immediately; the complete token is shown once.
4. Run the command over SSH on the printer's Linux host.
5. Use the printer's real config directory when prompted. The common path is
   `~/printer_data/config`.
6. Let the initial capture complete, then reload **Printers**.

If `hlab` is unavailable, confirm the release binary is installed and its
folder is on the printer user's `PATH`.

## Restore one file from history

Open **Recovery**, select a recovery point, choose **File to restore**, then
**Review file restore**. The diff compares that saved file with your current
draft, including unsaved local edits. Review the replacement and choose
**Restore file to draft** to stage it. A file removed from the current draft can
also be added back this way. Other draft files keep their current contents.

This creates a pending draft; it does not create a saved recovery point or change
the printer's confirmed applied state. Apply the draft on the printer when ready.
**Cancel file restore**, Escape or closing Recovery before confirmation leaves
the working draft unchanged. Single-file restore requires a cloud-linked printer.

Klippee refetches the saved source and current cloud revision before confirming.
If you edit locally after the preview, review the file again. If another browser
or printer capture changes the cloud draft, close Recovery and use **Review
conflict** first. If a write cannot be confirmed, your local edits remain intact
and sync pauses for review. Closing or navigating away during a confirmed write
also preserves local edits and requires conflict review before resuming.

## Resolve a workspace conflict

If another browser or desktop capture changes the cloud configuration, web
workspace sync pauses and your local edits stay open. Choose **Review conflict**
to compare each file's baseline, local contents and current cloud contents.
Independent file changes have a suggested result. When both sides changed the
same file, choose **Use local file** or **Use cloud file**. Choosing an absent
side removes that file from the reviewed result. If an older browser cache has
no recoverable baseline, differing files always require an explicit choice.

Choose **Stage reviewed files** to confirm the complete result for the connected
printer to apply. Klippee checks the latest cloud revision again and retains the
server's revision guard. If the cloud changes again, review the refreshed files
and confirm again. If you edit locally during review or staging, those newer
edits remain intact and require a new review. The result must retain at least
one file and pass the existing safety checks.

**Keep editing locally** closes the review without staging anything; sync stays
paused. Use **Refresh review** to include your newest local edits. File-level
choices keep an entire file; to combine changes within one file, keep editing
that file locally and review it again.

## Manage configuration from the command line

The **Printers** page shows whether a pending draft is available, the version
and time last confirmed on the selected printer, and the last reported host
details.

Run these commands from the configured printer host:

| Command | Purpose |
| --- | --- |
| `hlab klippee target` | Show the service, printer target, client role, and local folder. |
| `hlab klippee check --diff` | Compare local rendered files with the current printer target and baseline revision. |
| `hlab klippee apply` | Revalidate, back up, and install one exact target snapshot. |
| `hlab klippee capture` | Confirm the physical printer's loaded include graph as applied. |
| `hlab klippee capture --note "Tune input shaper"` | Capture with an optional human note. |
| `hlab klippee recover` | List cloud and local recovery points. |
| `hlab klippee recover cloud:4` | Restore a cloud recovery point and apply it. |
| `hlab klippee recover local:manual-...` | Restore a timestamped local backup. |
| `hlab klippee query-box-reset-reason` | Safely query a supported QIDI Box MCU's retained reset reason while Klippy is shut down. |
| `hlab klippee upload-diagnostics` | Privately upload a Klippy, Moonraker, journal, and runtime diagnostic bundle for 48 hours. |
| `hlab klippee install-moonraker` | Add safe Mainsail and Fluidd actions. |
| `hlab klippee install-timer` | Install a read-only timer that runs `check` every ten minutes. |

Important sync behaviour:

- `capture` starts at `printer.cfg` and follows its `[include ...]` graph,
  including relative paths, folders, and globs.
- Backups, `SAVE_CONFIG` snapshots, secrets, `saved_variables.cfg`, and
  unreferenced files are skipped and listed.
- An unchanged capture reports that the current target already matches.
- Capture output shows counts, not configuration or G-code bodies.
- Apply shows changed paths, asks before replacement, refetches the target to
  catch edits made during review, and creates a timestamped backup. Use `--yes`
  only after an operator or calling workflow has explicitly authorised apply.
- A successful physical apply reports the exact installed files and advances
  the printer's applied version and timestamp. A newer concurrent draft remains
  pending rather than being mistaken for the installed snapshot.
- Apply never restarts Klipper. The applied record confirms installation by the
  client, so review the result and restart Klipper manually.
- The managed timer is check-only; it never applies drafts or changes cloud
  state.

## Edit in a desktop IDE

The hlab CLI syncs a normal folder on Windows, macOS, or Linux using native Go.
Download [hlab v0.3.0 for your platform](https://github.com/cl-tim/hlab/releases/tag/v0.3.0)
and put it on your PATH. Existing
`.klippee/config.json` connections work unchanged. The printer's existing
Moonraker agent remains installed and compatible.

1. Create an empty folder where you want the configuration.
2. Open a terminal in that folder.
3. In Klippee, open **Printers**, select the printer, and expand
   **Edit on this PC**.
4. Choose the desktop operating system and create the one-time setup command.
5. Paste and run it in the terminal you opened.
6. Open that folder in your IDE.

For example:

```bash
mkdir printer-config
cd printer-config
# Run the generated setup command here.
hlab klippee check --diff
```

The generated setup command connects hlab and downloads the current desired
configuration. Confirm the connection with `hlab klippee target`.

After editing:

```bash
hlab klippee check --diff
hlab klippee capture --note "Edited in VS Code"
```

Use `hlab klippee apply` when you want the current printer target to replace the
desktop folder. Desktop apply keeps the same confirmation and backups, but does
not claim that the physical printer changed.

Desktop `capture` stages the edited files as the mutable pending draft. It does
not create applied history. The client supplies the revision saved when this
folder last synchronized; if the web editor or another desktop changed the
target since then, capture stops with a conflict and changes neither the cloud
draft nor the local baseline. Run `hlab klippee check --diff`, synchronize, and then
choose which side should win.

## Add Mainsail or Fluidd actions

After the printer CLI is working:

```bash
hlab klippee install-moonraker
```

Restart Klipper once. Mainsail or Fluidd will then show:

- `KLIPPEE_CHECK`
- `KLIPPEE_CAPTURE`
- `KLIPPEE_APPLY`
- `KLIPPEE_UPLOAD_DIAGNOSTICS`

The Moonraker-adjacent agent serialises commands and blocks capture or apply while
the printer is printing, paused, or its state is unknown. Results appear through
Klipper `RESPOND` messages and in:

```bash
journalctl --user -u klippee-moonraker.service -f
```

## Use Shared Configs

Open [**Shared Configs**](https://klippee.xyz/shared-configs) to browse public
configuration packages. Search by name, printer, or tag, then open a result to
inspect its files, hardware notes,
variables, warnings, version, and share link.

Use the [**Orca profiles** tab](https://klippee.xyz/shared-configs?type=orca) for
shared printer, filament, and process profiles. Older `/registry` links redirect
automatically to `/shared-configs`, preserving filters such as `?type=orca`.

Before using a package:

1. Confirm the exact printer and hardware revision.
2. Read all package warnings.
3. Choose **Configure package**.
4. Supply required printer-specific variables.
5. Review the rendered config and changed-file summary.
6. Download the rendered archive or bind it to the intended private printer.

Shared configs are community content and are not tested or endorsed by
Klippee. Never install solely because the printer model name appears to match.

### Delete an obsolete private package

Open **Shared Configs → Private packages** while signed in. Choose **Delete**,
review the package name and public-copy warning, then confirm **Delete private
package**. The hosted private copy and its entry in this browser's package
library are removed. Printer files, saved configuration history, companion
assets and independent copies in other browsers are unchanged.

Packages still bound to a printer in Klippee are protected. Unbind them first.
Published Shared Configs snapshots remain public and keep their existing URLs;
deleting a private source does not unpublish them. You can still edit your
public listing's details after deleting its private source. If another edit or
binding changes the package while you are confirming, refresh and review again.

### Publish and share a workspace config

1. Open **Klipper Workspace** for a printer with a cloud configuration.
   The printer must have confirmed at least one applied configuration.
2. Select **Publish to Shared Configs**.
3. Enter a clear listing title, printer model, hardware, and useful tags.
4. Review any safety warnings, then select **Publish to Shared Configs**.
5. Copy the public link shown in the workspace.

Publishing links the listing to this explicit printer and its repository. It
does not publish or promote the current editor draft. The link opens without
sign-in and serves a stored snapshot of the applied configuration you approved
when publishing. Draft autosaves and desktop captures remain private. A later
successful physical apply or capture updates the printer's applied record, but
not the public files; Klippee shows that newer configuration to you as
unpublished until you review and republish it. Private-only and sensitive files
are excluded.

To share a newer applied configuration, reopen **Publish to Shared Configs**,
review the exact applied-version files and safety findings shown there, and choose
**Approve and republish**. If the printer reports a different applied version
before the request completes, Klippee asks you to review again instead of
publishing different files. The public URL stays the same. Editing the listing
title, printer details, hardware, or tags does not approve or change its files.

Older linked listings continue to serve their existing stored snapshot. Open
the publishing flow and republish once to associate that snapshot with an exact
owner-approved applied version.

## Diagnose a Klippy log

Open **Diagnostics** to analyse local logs or recent private printer uploads.

### Analyse files from this computer

1. Drop or select `klippy.log`.
2. Optionally add Moonraker logs and kernel or journal exports.
3. Select a **Session scope**. The newest session is shown first; choose an
   earlier session when investigating an older print.
4. Review **Findings**, **Timeline**, **Thermals**, **MCU**, **Shutdowns**,
   **Snapshot**, **Config**, **Prints**, and **Compare**. **Snapshot** and
   **Config** appear only when a Klippee diagnostic bundle contains the
   corresponding structured evidence.
5. Expand a finding to see evidence and suggested checks.
6. Use **Export HTML** if you need a self-contained report.

Local files remain in the browser and are discarded on reload or when cleared.

The **Shutdowns** view reconstructs Klipper's native post-shutdown evidence. If
the failed MCU stopped responding before it could return a dump, the view makes
that explicit and separates it from other controllers that report
`Command request` because Klipper shut them down afterward. Recent MCU queues,
G-code, API requests, and motion-queue summaries are available for deeper
investigation.

The **Snapshot** view shows Klipper and Moonraker state at the moment the
diagnostic bundle was created, along with failed Moonraker components, warnings,
the current print, live sensor values, recent job outcomes, and cached G-code
context. It is capture-time evidence recorded after the newest log session, so
it is not filtered when you select an older session.

When available, Moonraker's recent one-second temperature history also appears
as a selectable chart under **Thermals**. This can preserve up to the configured
history window even when the Klippy log's regular `Stats` telemetry is sparse
near a failure.

The **Config** view shows the resolved Klipper settings that were active at the
last restart for diagnostically relevant sections such as MCUs, heaters,
sensors, motion, probes, and heater verification. It also calls out native
Klipper configuration warnings and changes waiting for `SAVE_CONFIG`.

Matching settings are added directly to heater, sensor, communication, motion,
stepper, and probe findings. For example, an MCU communication failure can show
the configured serial or CAN path, while a heater failure can show the active
sensor type, pins, temperature limits, maximum power, and verification
thresholds.

### Submit a log to improve the analyzer

After analysis, choose **Submit for improvements** if the analyzer missed or
misclassified something. This is optional and separate from local analysis.

1. Read the sharing notice. Logs can contain printer configuration, hardware
   identifiers, serial paths, hostnames, IP addresses, file paths, macro
   output, and print filenames.
2. Redact anything you do not want Klippee developers to see.
3. Confirm both consent checkboxes.
4. Choose **Submit for improvements**.

Submitted samples are not public. They are compressed, retained for up to 90
days, and available only to Klippee developers improving the analyzer. The
confirmation panel lets you immediately withdraw the submission.

The thermal chart plots measured temperature against setpoint for every sensor.
Hover or focus a sensor name or line to isolate it temporarily. Click the sensor
name or line to toggle it on or off.

### Upload from a printer

Run either:

```bash
hlab klippee upload-diagnostics
```

or the `KLIPPEE_UPLOAD_DIAGNOSTICS` dashboard macro. The private ZIP contains
the Klippy log plus any available Moonraker log, service/kernel journal
excerpts, resolved printer status, temperature and recent G-code history, and
host/runtime information. It also records a bounded USB serial topology map for
matching configured MCUs to kernel disconnect paths. The command lists missing sources as warnings without
blocking the upload. It expires after 48 hours and is limited to the newest five
uploads per printer.

Klippee keeps the newest 64 MiB of an unusually large Klippy log, the newest
8 MiB of supporting logs, and at most 2 MiB per journal excerpt. It rejects a
compressed bundle over 16 MiB. The browser workspace accepts at most 256 MiB of
selected input and stops compressed expansion beyond 512 MiB.

Klippee accepts four diagnostic uploads per printer per minute. If the CLI or
macro reports HTTP `429`, wait for the `Retry-After` interval before trying
again; creating another token for the same printer does not reset the limit.

## Create filament and slicer profiles

Open **Orca Workspace → Open preset editor** to manage individual saved presets.
Import a preset or bundle, or choose **New printer**, **New process** or **New
filament**. Enter a name, edit the applicable settings, and choose **Save preset**.
Signed-in saves are stored in your account's cloud preset library.

To remove one, select it, choose **Delete**, read the confirmation and choose
**Delete preset**. This removes the hosted preset and this browser's cached copy.
Presets attached to private configuration packages are protected; remove those
attachments or delete an unused package first. A changed preset requires a reload
before deletion. Pending imports, saves and publications must finish first.

Published copies and their public configuration links remain available. Deleting
a preset does not unpublish it, change printer files, remove saved configuration
history, or remove independent imported backups and saved setups. Local state is
kept if cloud deletion fails. Legacy or unrecognised formats appear under
**Other saved assets**, where they can also be inspected and deleted.

Publishing makes the profile public. Review notes, G-code, machine identifiers,
and any other content before sharing.

## Generate parametric CAD components

Open **Gridfinity Editor**, **OpenGrid Editor**, or **OpenGrid Underware
Editor** for transient parametric CAD work.

1. Select the type of component from the library on the left.
2. Adjust the component parameters on the right.
3. Choose **Generate preview**.
4. Inspect the interactive 3D preview.
5. Export the generated STL when satisfied.

The pre-loaded SCAD and generated geometry are processed transiently and are
not stored in Klippee. Component choices and parameters are saved only in the
current browser.

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

## More technical detail

- [Config editor](../config-editor.md)
- [Web editing and history](../web-editing-history.md)
- [Printer integration](../printer-integration.md)
- [Sync behaviour](../sync-behavior.md)
- [Log diagnostics](../log-diagnostics.md)
- [Parametric CAD editors](../openscad.md)
- [Safety policy](../safety-policy.md)
