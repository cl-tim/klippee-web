import { downloadBlob } from "../../rendering";
import type { KlippyLogAnalysis } from "./types";
import { formatSessionLabel } from "./sessionLabels";

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(value: number | null) {
  return value === null ? "Unknown" : `T+${value.toFixed(3)}s`;
}

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours ? `${hours}h ${minutes}m ${remainder}s` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function createKlippyHtmlReport(analysis: KlippyLogAnalysis) {
  const maximumReportEvents = 5_000;
  const maximumReportIncidents = 200;
  const duration = analysis.sessions.reduce((total, session) => total + Math.max(0, (session.lastTime ?? 0) - (session.firstTime ?? 0)), 0);
  const shutdowns = analysis.sessions.filter((session) => session.shutdownReason).length;
  const findingRows = analysis.findings.map((finding) => `
    <article class="finding ${finding.severity}">
      <div class="finding-label">${escapeHtml(finding.severity)}</div>
      <div>
        <div class="finding-heading"><h3>${escapeHtml(finding.title)}</h3><span>${escapeHtml(finding.confidence)} confidence</span></div>
        <p>${escapeHtml(finding.detail)}</p>
        ${finding.evidence.length ? `<div class="evidence">${finding.evidence.map((item) => `<div><strong>${escapeHtml(item.source)}, ${escapeHtml(formatSessionLabel(analysis.sessions, item.session))}, line ${item.line}, ${formatTime(item.time)}</strong><code>${escapeHtml(item.message)}</code></div>`).join("")}</div>` : ""}
        <h4>Checks</h4><ul>${finding.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>
      </div>
    </article>`).join("");
  const sessionRows = analysis.sessions.map((session) => `
    <tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, session.number))}</td><td>${escapeHtml(session.wallTime || "Not recorded")}</td><td>${session.startLine.toLocaleString()}-${session.endLine.toLocaleString()}</td><td>${formatTime(session.firstTime)}</td><td>${formatTime(session.lastTime)}</td><td>${escapeHtml(session.shutdownReason || "No shutdown recorded")}</td></tr>`).join("");
  const mcuRows = analysis.sessions.flatMap((session) => session.mcus.map((mcu) => `
    <tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, session.number))}</td><td><strong>${escapeHtml(mcu.name)}</strong><small>${escapeHtml(mcu.serialPath || "Endpoint not captured")}</small></td><td>${mcu.samples.toLocaleString()}</td><td>${signed(mcu.preShutdownRetransmittedBytesDelta)} / ${signed(mcu.postShutdownRetransmittedBytesDelta)}</td><td>${signed(mcu.preShutdownInvalidBytesDelta)} / ${signed(mcu.postShutdownInvalidBytesDelta)}</td><td>${mcu.finalSequenceLag}</td><td>${mcu.maxSequenceLag}</td><td>${mcu.maxQueuedBytes.toLocaleString()}</td><td>${mcu.stalledForSeconds.toFixed(1)}s</td></tr>`)).join("");
  const sensorRows = analysis.sessions.flatMap((session) => session.sensors.map((sensor) => `
    <tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, session.number))}</td><td>${escapeHtml(sensor.name)}</td><td>${sensor.minimum.toFixed(1)} C</td><td>${sensor.maximum.toFixed(1)} C</td><td>${sensor.final.toFixed(1)} C</td><td>${sensor.samples.toLocaleString()}</td></tr>`)).join("");
  const printRows = analysis.prints.map((print) => `
    <tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, print.session))}</td><td><strong>${escapeHtml(print.fileName)}</strong><small>${print.fileSize === null ? "Size not recorded" : `${(print.fileSize / 1024 / 1024).toFixed(2)} MiB`}</small></td><td><span class="outcome ${print.outcome}">${escapeHtml(print.outcome)}</span></td><td>${print.progress === null ? "Unknown" : `${(print.progress * 100).toFixed(1)}%`}</td><td>${print.startLine}</td><td>${print.endLine ?? "Not recorded"}</td><td>${escapeHtml(print.reason || "No final outcome was recorded.")}</td></tr>`).join("");
  const reportEvents = analysis.events.slice(0, maximumReportEvents);
  const eventRows = reportEvents.map((event) => `
    <tr data-severity="${event.severity}" data-session="${event.session}" data-search="${escapeHtml(`${event.source} ${event.category} ${event.message}`.toLowerCase())}"><td><i class="dot ${event.severity}"></i>${event.severity}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(formatSessionLabel(analysis.sessions, event.session))}</td><td>${formatTime(event.firstTime)}</td><td>${event.firstLine === event.lastLine ? event.firstLine : `${event.firstLine}-${event.lastLine}`}</td><td>${event.category}</td><td><code>${escapeHtml(event.message)}</code></td><td>${event.count.toLocaleString()}</td></tr>`).join("");
  const sourceRows = analysis.sources.map((source) => `
    <tr><td>${escapeHtml(source.name)}</td><td>${escapeHtml(source.kind)}</td><td>${source.lineCount.toLocaleString()}</td><td>${(source.size / 1024 / 1024).toFixed(2)} MiB</td><td>${source.compressed ? "gzip" : "plain text"}</td></tr>`).join("");
  const incidentRows = analysis.incidents.slice(0, maximumReportIncidents).map((incident) => `
    <article class="incident ${incident.severity}"><h3>${escapeHtml(incident.anchor.text)}</h3><small>${escapeHtml(incident.source)} | ${escapeHtml(formatSessionLabel(analysis.sessions, incident.session))} | line ${incident.anchor.line} | ${formatTime(incident.time)}</small>
    ${incident.commandContext.length ? `<h4>G-code and virtual SD context</h4><pre>${escapeHtml(incident.commandContext.join("\n"))}</pre>` : ""}
    <h4>Surrounding log lines</h4><pre>${escapeHtml([...incident.before, incident.anchor, ...incident.after].map((line) => `${line.line}: ${line.text}`).join("\n"))}</pre></article>`).join("");
  const shutdownRows = analysis.shutdownDumps.flatMap((dump) => {
    const lostMcu = /Lost communication with MCU '([^']+)'/i.exec(dump.reason)?.[1] ?? "";
    const rows = dump.mcus.map((mcu) => {
      const activity = [...mcu.sentMessages, ...mcu.receivedMessages]
        .map((message) => message.time)
        .filter((time): time is number => time !== null);
      return `<tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, dump.session))}</td><td>${escapeHtml(dump.reason)}</td><td>${escapeHtml(mcu.name)}</td><td>${escapeHtml(mcu.reason)}</td><td>${formatTime(activity.length ? Math.max(...activity) : null)}</td><td>${escapeHtml(`${mcu.sentMessages.length}/${mcu.sendQueueCount} sent, ${mcu.receivedMessages.length}/${mcu.receiveQueueCount} received`)}</td><td><code>send_seq=${escapeHtml(mcu.serialStats.send_seq ?? "?")} receive_seq=${escapeHtml(mcu.serialStats.receive_seq ?? "?")} retransmit=${escapeHtml(mcu.serialStats.bytes_retransmit ?? "?")} invalid=${escapeHtml(mcu.serialStats.bytes_invalid ?? "?")}</code></td></tr>`;
    });
    if (lostMcu && !dump.mcus.some((mcu) => mcu.name === lostMcu)) {
      rows.unshift(`<tr><td>${escapeHtml(formatSessionLabel(analysis.sessions, dump.session))}</td><td>${escapeHtml(dump.reason)}</td><td><strong>${escapeHtml(lostMcu)}</strong></td><td>Did not return a dump</td><td>Not responding</td><td>None</td><td>Initiating endpoint inferred from Klipper's exact shutdown reason</td></tr>`);
    }
    return rows;
  }).join("");
  const bundleEvidence = analysis.bundle?.evidence;
  const snapshotRows = bundleEvidence ? [
    ["Klipper state", bundleEvidence.printer?.state || bundleEvidence.server?.klippyState || "Unavailable"],
    ["Klipper message", bundleEvidence.printer?.message || "Unavailable"],
    ["Klipper version", bundleEvidence.printer?.softwareVersion || "Unavailable"],
    ["Moonraker", bundleEvidence.server?.moonrakerVersion || "Unavailable"],
    ["Klipper connection", bundleEvidence.server?.klippyConnected === null || bundleEvidence.server?.klippyConnected === undefined ? "Unknown" : bundleEvidence.server.klippyConnected ? "Connected" : "Disconnected"],
    ["Print at capture", bundleEvidence.print ? `${bundleEvidence.print.state}: ${bundleEvidence.print.filename || bundleEvidence.print.message || "filename unavailable"}` : "Unavailable"],
    ["Structured evidence", `${bundleEvidence.objectCount} objects, ${bundleEvidence.sensors.length} sensors, ${bundleEvidence.thermalHistory.length} thermal histories, ${bundleEvidence.gcode.length} G-code entries, ${bundleEvidence.jobs.length} jobs, ${bundleEvidence.usbSerialDevices.length} USB serial devices`],
  ].map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("") : "";
  const snapshotSensorRows = bundleEvidence?.sensors.map((sensor) =>
    `<tr><td>${escapeHtml(sensor.name)}</td><td>${sensor.temperature.toFixed(1)} C</td><td>${sensor.target === null ? "Not reported" : `${sensor.target.toFixed(1)} C`}</td><td>${sensor.power === null ? "Not reported" : `${(sensor.power * 100).toFixed(0)}%`}</td></tr>`).join("") ?? "";
  const snapshotHostSchedulingRows = bundleEvidence?.hostScheduling ? [
    ...Object.entries(bundleEvidence.hostScheduling.governors).map(([policy, governor]) =>
      `<tr><td>CPU policy</td><td>${escapeHtml(policy)}</td><td>${escapeHtml(governor)}</td><td></td></tr>`),
    ...bundleEvidence.hostScheduling.serialIrqs.map((irq) =>
      `<tr><td>Serial IRQ ${irq.irq}</td><td>${escapeHtml(irq.device)}</td><td>${escapeHtml(irq.requestedCpuList || "Unavailable")}</td><td>${escapeHtml(irq.effectiveCpuList || "Unavailable")}</td></tr>`),
    ...bundleEvidence.hostScheduling.services.map((service) =>
      `<tr><td>Service</td><td>${escapeHtml(service.name)}</td><td>${escapeHtml(service.cpuAffinity || "Default")}</td><td>${escapeHtml(service.cpuAllowedList || "Unavailable")}</td></tr>`),
  ].join("") : "";
  const snapshotUsbRows = bundleEvidence?.usbSerialDevices.map((device) =>
    `<tr><td><code>${escapeHtml(device.byId)}</code></td><td><code>${escapeHtml(device.tty)}</code></td><td><code>${escapeHtml(device.usbPath)}</code></td><td>${escapeHtml(device.product || device.manufacturer || `${device.vendorId}:${device.productId}`)}</td></tr>`).join("") ?? "";
  const snapshotJobRows = bundleEvidence?.jobs.map((job) =>
    `<tr><td>${escapeHtml(job.filename || "Filename unavailable")}</td><td>${escapeHtml(job.status)}</td><td>${job.startTime === null ? "Not recorded" : new Date(job.startTime * 1_000).toISOString()}</td><td>${job.endTime === null ? "Not recorded" : new Date(job.endTime * 1_000).toISOString()}</td><td>${formatDuration(job.printDuration)}</td><td>${formatDuration(job.totalDuration)}</td></tr>`).join("") ?? "";
  const snapshotWarnings = bundleEvidence
    ? [...(bundleEvidence.server?.failedComponents.map((component) => `Failed component: ${component}`) ?? []), ...(bundleEvidence.server?.warnings ?? []), ...bundleEvidence.parseWarnings]
    : [];
  const snapshotGcode = bundleEvidence?.gcode.slice(-100).map((entry) =>
    `${new Date(entry.time * 1_000).toISOString()} [${entry.type || "message"}] ${entry.message}`).join("\n") ?? "";
  const bundleConfig = bundleEvidence?.config;
  const configRows = bundleConfig?.sections.slice(0, 60).map((section) => {
    const options = Object.entries(section.options).slice(0, 12)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    return `<tr><td><strong>[${escapeHtml(section.name)}]</strong></td><td>${escapeHtml(section.kind)}</td><td><code>${escapeHtml(options)}</code></td></tr>`;
  }).join("") ?? "";
  const configWarnings = bundleConfig?.warnings.map((warning) =>
    `<li><strong>${escapeHtml(warning.type)}:</strong> ${escapeHtml(warning.message)}</li>`).join("") ?? "";
  const sessionOptions = analysis.sessions.map((session) => `<option value="${session.number}">${escapeHtml(formatSessionLabel(analysis.sessions, session.number))}</option>`).join("");
  const summarySession = analysis.summary.session === null ? "" : ` ${formatSessionLabel(analysis.sessions, analysis.summary.session)} contains the supporting evidence.`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Klippy Log Analysis: ${escapeHtml(analysis.fileName)}</title>
<style>
:root{--ink:#17212b;--muted:#63707d;--line:#d8e0e5;--page:#f4f6f7;--panel:#fff;--critical:#b42318;--error:#d14d41;--warning:#9a6700;--info:#1677a8}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 Inter,Segoe UI,Arial,sans-serif;letter-spacing:0}header{padding:28px max(22px,calc((100vw - 1400px)/2));background:#17212b;color:white;border-bottom:4px solid #32a37c}header h1{margin:0 0 5px;font-size:27px}header p{margin:0;color:#cbd5df;overflow-wrap:anywhere}main{max-width:1400px;margin:auto;padding:22px}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:25px}.metric{background:white;border:1px solid var(--line);border-radius:6px;padding:15px}.metric strong{display:block;font-size:24px}.metric span,small{color:var(--muted)}section{margin-bottom:28px}h2{font-size:20px;margin:0 0 3px}h3{font-size:15px;margin:0}h4{font-size:12px;text-transform:uppercase;margin:12px 0 4px}.section-copy{color:var(--muted);margin:0 0 10px}.conclusion{margin-bottom:20px;padding:16px 18px;background:#fff8e5;border:1px solid #e4c66f;border-left:5px solid var(--warning);border-radius:6px}.conclusion.failure{background:#fff2f0;border-color:#efaaa4;border-left-color:var(--critical)}.conclusion.clear{background:#eef8f4;border-color:#9dcdbd;border-left-color:#268667}.conclusion span{color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase}.conclusion h2{margin-top:3px}.conclusion p{margin:6px 0}.findings{display:grid;gap:8px}.finding{display:grid;grid-template-columns:90px 1fr;gap:15px;background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--info);border-radius:4px;padding:14px}.finding.critical{border-left-color:var(--critical)}.finding.error{border-left-color:var(--error)}.finding.warning{border-left-color:var(--warning)}.finding-label{text-transform:uppercase;font-size:11px;font-weight:750}.finding-heading{display:flex;justify-content:space-between;gap:12px}.finding-heading span{color:var(--muted);font-size:12px}.finding p{margin:5px 0}.finding ul{margin:0;padding-left:19px}.evidence{margin-top:10px;background:#f5f7f8;border:1px solid #e0e5e9;border-radius:4px;padding:8px}.evidence div+div{margin-top:7px}.evidence strong{display:block;font-size:11px;color:var(--muted)}code,pre{font-family:Consolas,monospace;overflow-wrap:anywhere}.evidence code{display:block}.incidents{display:grid;gap:8px}.incident{padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--warning);border-radius:5px}.incident.critical{border-left-color:var(--critical)}.incident.error{border-left-color:var(--error)}.incident pre{max-height:320px;margin:5px 0 0;padding:9px;overflow:auto;background:#f5f7f8;border:1px solid #e0e5e9;white-space:pre-wrap}.table-wrap{overflow:auto;background:white;border:1px solid var(--line);border-radius:6px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #e7ebef;vertical-align:top}th{background:#edf1f3;color:#44515e;font-size:11px;text-transform:uppercase;white-space:nowrap}tr:last-child td{border-bottom:0}td small{display:block;max-width:380px;font:11px Consolas,monospace;overflow-wrap:anywhere}.outcome{display:inline-block;padding:2px 6px;border-radius:3px;background:#edf1f3;font-size:11px;font-weight:700;text-transform:uppercase}.outcome.complete{color:#16705a;background:#e5f4ef}.outcome.failed,.outcome.interrupted{color:var(--critical);background:#fff2f0}.outcome.paused{color:var(--warning);background:#fff8e5}.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}button,select,input{height:35px;border:1px solid #bcc7cf;border-radius:4px;background:white;padding:0 10px;font:inherit}button{cursor:pointer}button.active{background:#223242;color:white;border-color:#223242}input{flex:1;min-width:250px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--info);margin-right:6px}.dot.critical{background:var(--critical)}.dot.error{background:var(--error)}.dot.warning{background:var(--warning)}footer{border-top:1px solid var(--line);padding-top:15px;color:var(--muted);font-size:12px}@media(max-width:760px){main{padding:14px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.finding{grid-template-columns:1fr;gap:4px}.finding-heading{display:block}input{min-width:100%}}@media print{.toolbar{display:none}.table-wrap{overflow:visible}section{break-inside:avoid}}
</style></head><body>
<header><h1>Klippy Log Analysis</h1><p>${escapeHtml(analysis.fileName)} | ${(analysis.byteSize / 1024 / 1024).toFixed(2)} MiB | generated ${new Date().toISOString()}</p></header>
<main><div class="summary"><div class="metric"><strong>${analysis.sessions.length}</strong><span>sessions</span></div><div class="metric"><strong>${analysis.prints.length}</strong><span>prints</span></div><div class="metric"><strong>${analysis.lineCount.toLocaleString()}</strong><span>log lines</span></div><div class="metric"><strong>${formatDuration(duration)}</strong><span>observed time</span></div><div class="metric"><strong>${shutdowns}</strong><span>shutdowns</span></div></div>
<section class="conclusion ${analysis.summary.tone}"><span>${analysis.summary.tone === "failure" ? "Recorded outcome" : analysis.summary.tone === "clue" ? "What this log can tell us" : "Analysis result"}</span><h2>${escapeHtml(analysis.summary.title)}</h2><p>${escapeHtml(analysis.summary.detail)}</p><small>${escapeHtml(summarySession)}</small></section>
<section><h2>Diagnostic Findings</h2><p class="section-copy">Rule-based findings retain confidence, evidence, and checks.</p><div class="findings">${findingRows || "<p>No recognized failures were found.</p>"}</div></section>
<section><h2>Sources</h2><p class="section-copy">${analysis.vendors.length ? `Detected integrations: ${escapeHtml(analysis.vendors.map((vendor) => vendor.name).join(", "))}. ` : ""}Files remain separate sources in the combined analysis.</p><div class="table-wrap"><table><thead><tr><th>File</th><th>Type</th><th>Lines</th><th>Input size</th><th>Encoding</th></tr></thead><tbody>${sourceRows}</tbody></table></div></section>
${bundleEvidence ? `<section><h2>Capture-time Runtime Snapshot</h2><p class="section-copy">Structured Moonraker evidence recorded when the diagnostic bundle was created, after the newest log session.</p><div class="table-wrap"><table><tbody>${snapshotRows}</tbody></table></div>${snapshotWarnings.length ? `<h3>Snapshot warnings</h3><ul>${snapshotWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}${snapshotHostSchedulingRows ? `<h3>Host scheduling</h3><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Name</th><th>Requested / configured</th><th>Effective / runtime</th></tr></thead><tbody>${snapshotHostSchedulingRows}</tbody></table></div>` : ""}${snapshotUsbRows ? `<h3>USB serial topology</h3><div class="table-wrap"><table><thead><tr><th>Stable serial path</th><th>TTY</th><th>Kernel USB path</th><th>Device</th></tr></thead><tbody>${snapshotUsbRows}</tbody></table></div>` : ""}${snapshotSensorRows ? `<h3>Live sensors</h3><div class="table-wrap"><table><thead><tr><th>Sensor</th><th>Temperature</th><th>Target</th><th>Power</th></tr></thead><tbody>${snapshotSensorRows}</tbody></table></div>` : ""}${snapshotJobRows ? `<h3>Recent jobs</h3><div class="table-wrap"><table><thead><tr><th>File</th><th>Outcome</th><th>Started</th><th>Ended</th><th>Print time</th><th>Total time</th></tr></thead><tbody>${snapshotJobRows}</tbody></table></div>` : ""}${snapshotGcode ? `<h3>Recent G-code context</h3><pre>${escapeHtml(snapshotGcode)}</pre>` : ""}</section>` : ""}
${bundleConfig ? `<section><h2>Active Klipper Configuration</h2><p class="section-copy">${bundleConfig.sectionCount} resolved sections were reported at the last Klipper restart; ${bundleConfig.retainedSectionCount} diagnostic sections were retained.${bundleConfig.pendingSave ? ` ${bundleConfig.pendingSaveItems.length || "Some"} SAVE_CONFIG items were pending.` : ""}</p>${configWarnings ? `<h3>Configuration warnings</h3><ul>${configWarnings}</ul>` : ""}<div class="table-wrap"><table><thead><tr><th>Section</th><th>Type</th><th>Resolved settings</th></tr></thead><tbody>${configRows}</tbody></table></div>${bundleConfig.sections.length > 60 ? `<p class="section-copy">${bundleConfig.sections.length - 60} additional retained sections were omitted from this report.</p>` : ""}</section>` : ""}
<section><h2>Sessions</h2><p class="section-copy">Sessions follow file order. Session 1 is the first segment and the highest number is the latest detected printer start. A partial first segment is labeled explicitly.</p><div class="table-wrap"><table><thead><tr><th>Session</th><th>Wall time</th><th>Lines</th><th>First sample</th><th>Last sample</th><th>Outcome</th></tr></thead><tbody>${sessionRows}</tbody></table></div></section>
<section><h2>Native Shutdown Reconstruction</h2><p class="section-copy">Klipper's send/receive dumps distinguish a non-responding endpoint from MCUs that remained reachable and shut down on command.</p><div class="table-wrap"><table><thead><tr><th>Session</th><th>Shutdown</th><th>MCU</th><th>MCU reason</th><th>Last activity</th><th>Retained queue</th><th>Serial state</th></tr></thead><tbody>${shutdownRows || "<tr><td colspan=\"7\">No native shutdown dump detected.</td></tr>"}</tbody></table></div></section>
<section><h2>Incident Context</h2><p class="section-copy">Bounded surrounding lines and recent G-code context for errors. ${analysis.incidents.length > maximumReportIncidents ? `${(analysis.incidents.length - maximumReportIncidents).toLocaleString()} additional incidents were omitted from this report.` : ""}</p><div class="incidents">${incidentRows || "<p>No error incidents were captured.</p>"}</div></section>
<section><h2>Print Outcomes</h2><p class="section-copy">Virtual SD lifecycle events are correlated with file size, position, nearby failures, pauses, cancellations, and restarts.</p><div class="table-wrap"><table><thead><tr><th>Session</th><th>File</th><th>Outcome</th><th>Progress</th><th>Start line</th><th>End line</th><th>Reason</th></tr></thead><tbody>${printRows || "<tr><td colspan=\"7\">No virtual SD prints detected.</td></tr>"}</tbody></table></div></section>
<section><h2>MCU Communication</h2><p class="section-copy">Counter deltas before the first shutdown are shown separately from post-shutdown cleanup traffic.</p><div class="table-wrap"><table><thead><tr><th>Session</th><th>MCU / endpoint</th><th>Samples</th><th>Retransmit before / after</th><th>Invalid before / after</th><th>Final lag</th><th>Max lag</th><th>Max queued</th><th>End stall</th></tr></thead><tbody>${mcuRows}</tbody></table></div></section>
<section><h2>Event Timeline</h2><p class="section-copy">${analysis.events.length > maximumReportEvents ? `The first ${maximumReportEvents.toLocaleString()} of ${analysis.events.length.toLocaleString()} retained events are included to keep this report responsive.` : `${analysis.events.length.toLocaleString()} retained events.`}</p><div class="toolbar"><button class="active" data-level="all">All</button><button data-level="critical">Critical</button><button data-level="error">Errors</button><button data-level="warning">Warnings</button><button data-level="info">Info</button><select id="session"><option value="all">All sessions</option>${sessionOptions}</select><input id="search" type="search" placeholder="Search events"></div><div class="table-wrap"><table id="timeline"><thead><tr><th>Severity</th><th>Source</th><th>Session</th><th>Time</th><th>Lines</th><th>Category</th><th>Message</th><th>Count</th></tr></thead><tbody>${eventRows}</tbody></table></div></section>
<section><h2>Temperature Ranges</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Sensor</th><th>Minimum</th><th>Maximum</th><th>Final</th><th>Samples</th></tr></thead><tbody>${sensorRows}</tbody></table></div></section>
<footer>Generated locally by Klippee Log Diagnostics. Review serial identifiers and log evidence before sharing.</footer></main>
<script>(()=>{let level='all';const rows=[...document.querySelectorAll('#timeline tbody tr')],session=document.querySelector('#session'),search=document.querySelector('#search');function apply(){const query=search.value.trim().toLowerCase();rows.forEach(row=>row.hidden=!((level==='all'||row.dataset.severity===level)&&(session.value==='all'||row.dataset.session===session.value)&&(!query||row.dataset.search.includes(query))))}document.querySelectorAll('button[data-level]').forEach(button=>button.addEventListener('click',()=>{level=button.dataset.level;document.querySelectorAll('button[data-level]').forEach(item=>item.classList.toggle('active',item===button));apply()}));session.addEventListener('change',apply);search.addEventListener('input',apply)})();</script></body></html>`;
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

export function downloadKlippyHtmlReport(analysis: KlippyLogAnalysis) {
  const report = createKlippyHtmlReport(analysis);
  downloadBlob(
    new Blob([report], { type: "text/html;charset=utf-8" }),
    `${analysis.fileName.replace(/\.[^.]+$/, "") || "klippy"}-analysis.html`,
  );
}
