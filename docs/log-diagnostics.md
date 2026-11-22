# Klippy Log Diagnostics

Klippee includes a browser-native analyzer for Klipper diagnostic logs. Open
**Log Diagnostics** from the primary navigation and select or drop one or more
plain-text or gzip-compressed logs, or a Klippee diagnostic ZIP bundle.
`klippy.log`, Moonraker logs, and kernel/journal exports can be analyzed
together while remaining identifiable as separate sources.

Files selected from the local computer are analyzed entirely in the browser and
are not uploaded. A configured printer can explicitly send its current log with
`klippee upload-diagnostics` or the `KLIPPEE_UPLOAD_DIAGNOSTICS`
Mainsail/Fluidd macro. The printer client creates a single diagnostic ZIP
containing the current Klippy log and any available bounded supporting evidence:

- `moonraker.log`
- Klipper, Moonraker, and kernel journal excerpts
- Moonraker printer/server information
- resolved `configfile` state, runtime object status, heaters, sensors, MCUs,
  print state, and system statistics
- Moonraker temperature history, recent G-code, job history, and process/system
  snapshots
- a bounded `/dev/serial/by-id` to kernel USB-topology map for correlating a
  configured MCU with kernel disconnect records
- a versioned manifest describing every artifact, truncation, and collection
  warning

Unavailable APIs or journals do not prevent upload. Their absence is recorded
in the manifest and shown in the analyzer so missing evidence is not mistaken
for a healthy signal.

Those opt-in uploads are stored privately for 48 hours, limited to the newest
five per printer, and downloaded into the same browser-side parser when opened.
The ZIP is expanded incrementally in the analysis web worker. Recognized log
entries are sent through the line analyzer, while supported Moonraker snapshots
are normalized into bounded runtime evidence and findings.
The workspace accepts up to 256 MiB
of selected input and stops if compressed data expands beyond 512 MiB. Analysis
is discarded when the page is reloaded or the user clears it.

Printer bundles are ZIP-compressed and limited to 16 MiB. The Klippy log is
bounded to its newest 64 MiB, supporting logs to their newest 8 MiB, and each
journal excerpt to its newest 2 MiB. The diagnostics inbox identifies bundles
with truncated sources and allows immediate deletion. Legacy plain-text and
gzip printer uploads remain accepted.

Each printer can start four diagnostic uploads per 60 seconds. All sync tokens
bound to that printer share the allowance. A rejected request returns `429`
with `Retry-After: 60` before Klippee reads the bundle or reserves storage.

Structured snapshot analysis retains at most 4 MiB per supported snapshot and
16 MiB across all snapshots. The analyzer currently reads printer and server
state, queried Klipper objects, cached temperatures, cached G-code responses,
recent Moonraker job history, and Klipper's resolved `configfile` state.
It also reads the capture-time USB serial map and can prove which configured
MCU occupied a disconnected kernel USB path when both records agree.
Malformed or oversized snapshots are reported as missing evidence without
discarding valid logs from the same bundle.

After analyzing local or printer-uploaded files, a signed-in user can choose
**Submit for improvements**. This is a separate, deliberate contribution flow:
the user must confirm that printer and host information will be shared with
Klippee developers and that they reviewed and redacted anything they do not
want to share. Contributed samples are never made public, are normalized to
gzip in R2, and expire after 90 days. The user can withdraw the contribution
immediately from its confirmation panel.

One account can submit up to 24 improvement files per 60 seconds, which leaves
headroom around the 20-file contribution batch. Sessions share the same
allowance. A `429` response includes `Retry-After: 60` and does not store the
rejected file.

Developers can download all active contributions with:

```bash
KLIPPEE_ORIGIN=https://klippee.example.com \
  KLIPPEE_REVIEW_TOKEN="<secret>" npm run diagnostics:download-submissions
```

Use `-- --output <folder>` to choose a destination or `-- --origin <url>` for
a non-production environment. The command verifies each gzip object's SHA-256
checksum and writes a local `manifest.json`. The review token is sent only in
the `Authorization` header and must match the `LOG_IMPROVEMENT_REVIEW_TOKEN`
Cloudflare secret.

The parser also bounds retained telemetry, unique events, incident contexts,
sensor names, MCU names, and individual line length. Telemetry is progressively
compacted while preserving the start and end of each session. When safeguards
discard or compact data, the workspace reports exactly what was affected.

## Report contents

The analyzer separates concatenated Klipper runs using explicit boundaries and
backward jumps in `Stats` time. It extracts:

- shutdowns, lifecycle events, errors, warnings, and recurring messages
- virtual SD print outcomes, filenames, progress, pause/resume segments, runout
  context, cancellations, failures, and restart interruptions
- MCU endpoints, firmware descriptions, sequence lag, queued bytes,
  retransmits, invalid bytes, and terminal counter stalls
- host load, available memory, and print-buffer telemetry
- temperature ranges and measured-versus-setpoint charts for every sensor
  published in `Stats` lines, with failure markers and selectable traces
- temperature jumps, flatlined or slow heating under power, and significant
  overshoot inferred from retained telemetry
- MCU counter trend charts and findings for increasing retransmits, invalid
  bytes, sequence lag, and queued data, with pre-shutdown growth separated from
  counters accumulated during shutdown cleanup
- event-local `Timer too close` correlation across the reporting MCU, serial
  endpoint, transport counters, Klipper CPU time, host load, memory, and host
  temperature
- native Klipper shutdown reconstruction, including the last bounded
  send/receive queues for each responding MCU, recent G-code and API requests,
  and motion-queue summaries
- capture-time Klipper and Moonraker state, failed Moonraker components,
  initialization warnings, current print state, live sensor values, cached
  G-code context, and recent job outcomes from diagnostic bundles
- capture-time CPU governors, serial IRQ affinities, runtime service CPU masks,
  and irqbalance/ondemand service state from printer-created bundles
- capture-time USB serial identity and topology, correlated with configured MCU
  serial paths and kernel disconnect events
- Moonraker's recent one-second temperature history as an additional selectable
  thermal chart, with findings when a heater remains flat or cools under
  sustained high power
- bounded resolved Klipper settings for MCU connections, heaters, sensors,
  motion, probes, and heater verification, correlated with matching diagnostic
  findings
- native Klipper configuration warnings and pending `SAVE_CONFIG` changes
- bounded incident bundles containing the error, surrounding lines, and recent
  virtual SD/G-code context
- source attribution, common vendor/integration detection, and side-by-side
  session comparison
- evidence-backed findings with severity, confidence, source lines, and checks

The **Export HTML** action creates a self-contained report with a searchable,
filterable event timeline. Report generation is independently bounded to 5,000
events and 200 incidents so export cannot recreate an excessive browser
allocation. Exported reports preserve serial paths, firmware identifiers, and
selected log messages because they are diagnostic evidence. Review the file
before sharing it publicly.

## Diagnostic coverage

Rules currently cover:

- USB, serial, CAN, and generic MCU communication failures
- retransmit, invalid-byte, clock-sync, scheduling, watchdog, and protocol
  failures
- heater verification, ADC/sensor range, thermal limit, and cold extrusion
  failures, including requested temperatures and combined-sensor disagreement
- homing, endstop, traditional and eddy-current probes, bed mesh, gantry
  leveling, move-range, and extrusion-limit failures
- TMC driver status and UART/SPI read or write communication faults
- invalid configuration, missing includes, SAVE_CONFIG failures, pin conflicts,
  macro/template failures, Python exceptions, and unavailable G-code commands
- accelerometer, load-cell, auxiliary sensor, and calibration failures
- virtual SD/filesystem errors, host resource pressure, brownouts, power loss,
  and reset signatures

Emergency stops requested through M112, a kill input, or the webhooks API are
identified separately from spontaneous hardware shutdowns. Routine command
state such as an already-paused print or an SD worker being busy is retained in
the timeline without being described as broken hardware.

TMC undervoltage status observed during startup is retained but downgraded when
the same driver reports a zero status before printing begins. If the fault
returns during motion or heating it remains a critical driver or power finding.

Rules distinguish observed facts from inferred causes. If Klipper shuts down for
an unfamiliar reason, the result is explicitly labeled **unclassified** and
retains the exact shutdown text instead of assigning it to an unrelated failure
family.

`No trigger on probe after full movement` is identified as a probe travel
failure, including during gantry leveling after successful homing. Its finding
links captured probe settings, Z travel limits, and leveling points when present;
the summary surfaces the probe error ahead of a generic failed-print outcome.

The **Shutdowns** view uses Klipper's own post-shutdown dump to separate the
initiating failure from controllers that were stopped afterward. For example,
when a log reports lost communication with an MCU that does not return a dump,
while the remaining MCUs report `Command request`, the missing endpoint is
identified as the likely initiator and the responding MCUs are described as
downstream shutdowns. Equivalent explicit host-command wording is treated the
same way. The view preserves bounded recent queue messages and
supporting G-code, API, and motion context without retaining an unbounded dump.

The **Snapshot** view appears for diagnostic bundles with supported Moonraker
evidence. Snapshot values are recorded when the bundle is created, after the
newest log session, so they intentionally do not change when an older session
is selected. Moonraker documents printer object queries in its
[Printer Administration API](https://moonraker.readthedocs.io/en/latest/external_api/printer/),
the one-second FIFO temperature history in its
[Server Administration API](https://moonraker.readthedocs.io/en/latest/external_api/server/),
and print outcomes in its
[Job History API](https://moonraker.readthedocs.io/en/latest/external_api/history/).

The **Config** view shows a bounded diagnostic subset of Klipper's resolved
settings at the last software restart. These settings include defaults, while
the raw configuration contains only explicitly written values. Runtime changes
after the restart are not reflected. When a finding names a heater, sensor,
MCU, stepper, or probe, the analyzer attaches the matching active settings so
the configured sensor model, pins, communication path, safety range, and
verification thresholds can be checked against the installed hardware.
Klipper's [Status Reference](https://www.klipper3d.org/Status_Reference.html#configfile)
defines the resolved settings, raw values, configuration warnings, and pending
`SAVE_CONFIG` fields.

## Extending the analyzer

Failure signatures live in
`src/features/logDiagnostics/failureRules.ts`. Each rule defines a stable id,
family, severity, confidence, matching patterns, explanation, and practical
checks. Add or change rules alongside a focused fixture in
`src/features/logDiagnostics/analyzer.test.ts`.

Parsing and report generation are separate from React:

- `fileAnalyzer.ts` streams plain and gzip sources into the parser.
- `diagnosticBundleEvidence.ts` normalizes bounded Moonraker snapshots and
  creates capture-time findings.
- `diagnosticConfigEvidence.ts` bounds resolved Klipper settings and correlates
  them with matching findings.
- `diagnosticUsbEvidence.ts` ties configured MCU serial names to kernel USB
  topology without requiring an SSH session after the incident.
- `logDiagnostics.worker.ts` runs file ingestion outside the UI thread.
- `analyzer.ts` incrementally parses sessions and builds findings.
- `shutdownDump.ts` reconstructs bounded native Klipper shutdown evidence.
- `vendorProfiles.ts` detects optional vendor and integration signatures.
- `report.ts` renders the downloadable standalone report.
- `LogDiagnosticsView.tsx` provides the browser workspace.

Run `npm run test:web`, `npm run test:ui`, and `npm run build` after changing
diagnostic behavior or presentation.
