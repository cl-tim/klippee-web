# Config Editor

The Klippee web product has two related editor experiences:

- Public package configurator: turn a shared package into a printer-ready
  download.
- Private config editor: edit a user's mutable pending draft, which a physical
  printer can review and explicitly apply.

This is useful for people who want to reuse a public package without setting up
private sync first.

## Core Flow

Example package: QIDI X-Plus 4 with Beacon and Box.

1. User opens the public package page.
2. Klippee shows package metadata, files, warnings, and required variables.
3. User enters values such as Beacon serial path and Box MCU serial paths.
4. Klippee validates the values.
5. User previews rendered files and a changed-file summary.
6. User downloads a `.zip` containing the rendered config.

## Editor Surfaces

### Package Overview

The overview should show:

- printer model and hardware profile
- package version
- included files
- known warnings
- required variables
- compatibility notes

### Variable Panel

The variable panel is generated from the package manifest's `variables` array.

Each variable should show:

- label
- description
- type
- required state
- example value
- validation errors

For `device-path` variables, the UI should make it clear that values are
printer-specific and commonly look like `/dev/serial/by-id/...`.

Secret variables should use password-style inputs and should not appear in
rendered public previews.

### File Preview

The preview should support:

- raw template view
- rendered view
- diff between template and rendered output
- warnings near affected lines

The raw template view shows placeholders such as:

```ini
[beacon]
serial: ${KLIPPEE:beacon_serial}
```

The rendered view shows the value entered by the user.

### Download

The download action creates a `.zip` containing:

```text
klippee-render-summary.json
printer.cfg
moonraker.conf
KAMP/
macros/
extras/
```

The summary file should include:

- package name and version
- render timestamp
- variable names used
- file hashes for rendered outputs
- unresolved warnings

The summary should not include secret values. For non-secret machine identifiers,
the summary may include values when the zip is generated for the current user.

## Saving Values

Anonymous users can enter variable values and download a zip without saving
anything server-side.

Signed-in users can optionally save values to a private printer profile, making
future downloads and sync flows quicker.

Saved values are private to the user and printer profile.

The editor groups supporting workflows in the **Workspace tools** dock below
the active file instead of a narrow right-hand rail. Variables are created from
the editor instead of a generated list of machine-specific candidates:

1. Select a literal value in the editor. Selecting its whole config line is
   also supported; Klippee isolates the value after `:` or `=` and preserves
   the option name and trailing comment.
2. Choose **Make variable**, review the suggested name and exact placeholder,
   then choose **Convert value**.
3. Open **Workspace tools → Variables** to confirm the value for the selected
   printer.

Only the selected occurrence changes. Klippee does not replace matching values
elsewhere in the workspace. For each converted value, Klippee:

1. Replaces the literal with a named `${KLIPPEE:name}` placeholder.
2. Uses the original non-secret literal as the selected printer's initial value.
3. Shows the value and rendered preview in **Variables** for review.
4. Leaves the workspace as an autosaved pending draft. It becomes an immutable
   recovery point and the applied record only after the physical printer runs
   `klippee apply` (or captures its current files).

Secret values are never seeded into the browser printer profile. Set them on
the printer host with `klippee variables set <name> <value>`.

The **Recovery** tool lists immutable repository versions and labels identical
snapshots as duplicates. A version can be deleted after inline confirmation
unless it is the only remaining version or the selected printer's last
confirmed applied configuration. Deletion never moves the applied pointer to a
version that the printer did not report.

## Validation

The editor should block download when:

- required variables are missing
- variable values fail type validation
- rendered output still contains unresolved `${KLIPPEE:name}` placeholders
- a block-level safety finding is present

The editor should warn, but allow explicit confirmation, when:

- local IPs or hostnames are present
- device paths look unusual
- calibration values appear machine-specific
- files include Moonraker authorization or CORS sections

## API Shape

Render request:

```json
{
  "variables": {
    "beacon_serial": "/dev/serial/by-id/usb-Beacon_Beacon_RevH_..."
  }
}
```

Render response:

```json
{
  "ok": true,
  "missingVariables": [],
  "warnings": [],
  "files": [
    {
      "path": "printer.cfg",
      "role": "entrypoint",
      "sha256": "rendered-file-hash",
      "rendered": true
    }
  ]
}
```

The zip endpoint can accept the same request body and return the generated
archive.

## Private Editing

Private repository editing is covered in
[`web-editing-history.md`](web-editing-history.md). It should reuse the same file
preview, variable rendering, and safety warning components. Editor autosave
updates a mutable draft rather than creating an immutable version; the physical
printer establishes version history and applied state through explicit apply or
capture operations.
