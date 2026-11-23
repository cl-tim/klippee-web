# Desktop and printer integration
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

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
See the [hlab documentation](https://cl-tim.github.io/hlab/) and download [hlab v0.3.0 for your platform](https://github.com/cl-tim/hlab/releases/tag/v0.3.0)
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
