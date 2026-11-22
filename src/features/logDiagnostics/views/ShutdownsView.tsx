import { AlertTriangle, ShieldCheck } from "lucide-react";
import { formatEventTime } from "../formatters";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis } from "../types";

export function ShutdownsView({
  analysis,
  dumps,
}: {
  analysis: KlippyLogAnalysis;
  dumps: KlippyLogAnalysis["shutdownDumps"];
}) {
  if (!dumps.length) {
    return <div className="diagnostics-empty">
      <ShieldCheck size={22} />
      <strong>No native Klipper shutdown dump in this scope</strong>
      <span>Shutdown queue reconstruction appears here when the log contains Klipper's Dumping sections.</span>
    </div>;
  }
  return <div className="diagnostics-view shutdown-dump-list">
    {dumps.map((dump, index) => {
      const lostMcu = /Lost communication with MCU '([^']+)'/i.exec(dump.reason)?.[1] ?? "";
      const lostMcuDumped = dump.mcus.some((mcu) => mcu.name === lostMcu);
      return <details className="shutdown-dump" key={`${dump.source}-${dump.line}`} open={index === 0}>
        <summary>
          <span><strong>{dump.reason}</strong><small>{formatSessionLabel(analysis.sessions, dump.session)} · {dump.source} · lines {dump.line.toLocaleString()}–{dump.endLine.toLocaleString()}</small></span>
          <span>{dump.mcus.length} responding MCUs</span>
        </summary>
        <div className="shutdown-dump-body">
          {lostMcu && !lostMcuDumped && <div className="shutdown-root-cause">
            <AlertTriangle size={18} />
            <span><strong>{lostMcu} did not return a shutdown dump</strong>The MCUs listed below still responded to Klipper. A missing failed endpoint plus responding controllers marked “Command request” isolates the initiating communication loss.</span>
          </div>}
          <div className="diagnostics-table-wrap" role="region" aria-label="Shutdown details" tabIndex={0}><table className="diagnostics-table">
            <thead><tr><th>MCU</th><th>Shutdown reason</th><th>Last queue activity</th><th>Serial state</th><th>Retained queue</th></tr></thead>
            <tbody>{dump.mcus.map((mcu) => {
              const activity = [...mcu.sentMessages, ...mcu.receivedMessages]
                .map((message) => message.time)
                .filter((time): time is number => time !== null);
              return <tr key={`${mcu.line}-${mcu.name}`}>
                <td><strong>{mcu.name}</strong><small className="diagnostics-endpoint">Line {mcu.line}</small></td>
                <td>{mcu.reason}</td>
                <td>{formatEventTime(activity.length ? Math.max(...activity) : null)}</td>
                <td><code>send_seq={String(mcu.serialStats.send_seq ?? "?")} receive_seq={String(mcu.serialStats.receive_seq ?? "?")} retransmit={String(mcu.serialStats.bytes_retransmit ?? "?")} invalid={String(mcu.serialStats.bytes_invalid ?? "?")}</code></td>
                <td>{mcu.sentMessages.length}/{mcu.sendQueueCount} sent · {mcu.receivedMessages.length}/{mcu.receiveQueueCount} received</td>
              </tr>;
            })}</tbody>
          </table></div>
          {dump.mcus.map((mcu) => <details className="shutdown-queue" key={`queue-${mcu.line}-${mcu.name}`}>
            <summary>Recent {mcu.name} queue messages</summary>
            <div className="shutdown-message-list">
              {[...mcu.sentMessages.map((message) => ({ ...message, direction: "Sent" })), ...mcu.receivedMessages.map((message) => ({ ...message, direction: "Received" }))]
                .sort((left, right) => (left.time ?? 0) - (right.time ?? 0))
                .map((message, messageIndex) => <div key={`${message.direction}-${message.line}-${messageIndex}`}>
                  <span>{message.direction} · {formatEventTime(message.time)}{message.sequence ? ` · seq ${message.sequence}` : ""}</span>
                  <code>{message.text || "(no decoded command text)"}</code>
                </div>)}
            </div>
          </details>)}
          {(dump.gcodeCommands.length > 0 || dump.motionQueues.length > 0 || dump.apiRequests.length > 0) && <div className="shutdown-supporting-context">
            {dump.gcodeCommands.length > 0 && <section><h3>Recent G-code input</h3>{dump.gcodeCommands.map((command) => <code key={`${command.line}-${command.text}`}>{formatEventTime(command.time)} · {command.text}</code>)}</section>}
            {dump.motionQueues.length > 0 && <section><h3>Motion queues</h3>{dump.motionQueues.map((queue) => <code key={`${queue.line}-${queue.kind}-${queue.name}`}>{queue.kind} {queue.name || "(primary)"}{queue.mcu ? ` on ${queue.mcu}` : ""} · {queue.count} queued entries</code>)}</section>}
            {dump.apiRequests.length > 0 && <section><h3>Recent API requests</h3>{dump.apiRequests.map((request) => <code key={`${request.line}-${request.text}`}>{formatEventTime(request.time)} · {request.text}</code>)}</section>}
          </div>}
        </div>
      </details>;
    })}
  </div>;
}
