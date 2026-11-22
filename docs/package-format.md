# Package Format

A Klippee package is a versioned Klipper config bundle described by a
`klippee.json` manifest.

The manifest is the stable contract between the web app, sync client, import
tools, and Shared Configs.

The draft JSON Schema lives at
[`schemas/package.v1.schema.json`](../schemas/package.v1.schema.json).

## Directory Layout

Recommended package layout:

```text
klippee.json
printer.cfg
moonraker.conf
macros/
KAMP/
extras/
```

Raw imports can start from any directory shape, but publishing should normalize
metadata into `klippee.json`.

## Manifest Example

```json
{
  "schema": "https://klippee.app/schemas/package.v1.json",
  "name": "qidi-x-plus-4-beacon-box",
  "title": "QIDI X-Plus 4 with Beacon and Box",
  "visibility": "public",
  "version": "2026.04.21",
  "license": "MIT",
  "printer": {
    "manufacturer": "QIDI",
    "model": "X-Plus 4"
  },
  "hardware": {
    "probe": "Beacon",
    "enclosure": "QIDI Box",
    "board": null,
    "extruder": null
  },
  "software": {
    "klipper": null,
    "moonraker": null,
    "ui": ["Fluidd", "Mainsail"]
  },
  "variables": [
    {
      "name": "beacon_serial",
      "label": "Beacon USB serial path",
      "description": "Serial path for this printer's Beacon probe.",
      "type": "device-path",
      "required": true,
      "secret": false,
      "example": "/dev/serial/by-id/usb-Beacon_Beacon_RevH_...-if00"
    }
  ],
  "files": [
    {
      "path": "printer.cfg",
      "role": "entrypoint",
      "sha256": "replace-me",
      "public": true
    },
    {
      "path": "gcode_macro.cfg",
      "role": "macro",
      "sha256": "replace-me",
      "public": true
    }
  ],
  "ignore": [
    "saved_variables.cfg",
    "*.bak",
    "*.bkp",
    "*.7z",
    "printer-*_[0-9]*.cfg"
  ],
  "warnings": []
}
```

## Required Fields

- `schema`
- `name`
- `title`
- `visibility`
- `version`
- `printer.manufacturer`
- `printer.model`
- `files`

## Variables

Some config values are tied to a specific printer even when the rest of the
package is reusable. Examples include Beacon USB serial paths, extra MCU serial
paths, CAN UUIDs, camera device paths, local hostnames, and calibration values.

Klippee packages should keep those values as declared variables instead of
publishing someone else's hardware identifiers as ordinary config text.

Use this placeholder syntax inside config files:

```ini
[beacon]
serial: ${KLIPPEE:beacon_serial}
```

For a QIDI Box MCU, a package might use:

```ini
[mcu mcu_box1]
serial: ${KLIPPEE:qidi_box_1_serial}
```

The placeholder syntax is deliberately not Jinja syntax because Klipper macros
already use Jinja expressions such as `{% set value = ... %}` and `{value}`.

### Variable Declaration

Every placeholder used by package files must be declared in `variables`.

```json
{
  "name": "beacon_serial",
  "label": "Beacon USB serial path",
  "description": "Serial path for this printer's Beacon probe.",
  "type": "device-path",
  "required": true,
  "secret": false,
  "example": "/dev/serial/by-id/usb-Beacon_Beacon_RevH_...-if00"
}
```

Supported variable types:

- `string`: plain text
- `number`: numeric value
- `boolean`: true or false
- `device-path`: Linux device path such as `/dev/serial/by-id/...`
- `serial-id`: device serial, CAN UUID, or board identifier
- `hostname`: hostname or local domain
- `ip-address`: IPv4 or IPv6 address
- `url`: URL
- `secret`: token, password, or other sensitive value

Values for variables are not stored in public package versions. They live in a
private printer installation profile and are applied when the package is loaded
onto a printer.

The web editor should build its variable form from these declarations so a user
can configure a public package and download rendered config files as a `.zip`.

### Rendering

When loading a package onto a printer, the sync client should:

1. Fetch the package manifest and file blobs.
2. Collect required variable values from the printer profile or user prompt.
3. Validate each value against its type and optional pattern.
4. Replace `${KLIPPEE:name}` placeholders in text files.
5. Refuse to write files while required variables are missing.

The original package blob should remain unrendered and content-addressed. The
rendered printer-local output is a deployment artifact, not the canonical public
package.

The same rendering rules apply to browser-based zip downloads. Anonymous users
may provide values for a one-off render without saving them, while signed-in
users may save values to a private printer profile.

## File Roles

The `role` field helps Klippee understand how to show, validate, and sync each
file.

Recommended roles:

- `entrypoint`: main `printer.cfg`
- `macro`: G-code macro file
- `include`: included Klipper config
- `moonraker`: Moonraker config
- `ui`: Fluidd, Mainsail, webcam, or UI-adjacent config
- `calibration`: bed mesh, probe, resonance, or tramming config
- `state`: generated runtime state
- `backup`: historical or generated backup
- `archive`: compressed archive
- `unknown`: imported but not classified yet

## Visibility

Visibility controls access:

- `public`: listed in Shared Configs and downloadable by anyone
- `unlisted`: accessible by direct link
- `private`: visible only to the owner and authorized sync tokens

## Version Names

For public packages, prefer human-readable versions:

```text
2026.04.21
1.0.0
klipper-v0.13-qidi-box
```

For private snapshots, timestamped versions are acceptable:

```text
2026-05-12T13-42-09Z
```

## Import Rules

The importer should classify files before creating a publishable package.

Default public includes:

- `printer.cfg`
- explicitly included `.cfg` files
- macros
- KAMP settings
- calibration helper files
- documented accessory configs

Default public excludes:

- `saved_variables.cfg`
- `moonraker.secrets`
- `moonraker.cfg`
- files under hidden folders such as `.klippee/` or `.git/`
- `*.bak`
- `*.bkp`
- `*.7z`
- `*.zip`
- `*.tar`
- dated backup configs
- files containing tokens, passwords, private keys, or API credentials

Workspace folder import rejects excluded files before reading them into the
browser workspace. Users who need service credentials or runtime state should
keep those files outside Klippee and manually extract only the safe `.cfg`
definitions they want to track.

The importer should also suggest variables when it detects machine-specific
values such as `/dev/serial/by-id/...`, CAN UUIDs, camera device paths, static
IPs, or local hostnames.
