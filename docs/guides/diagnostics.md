# Klippy log diagnostics
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

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
