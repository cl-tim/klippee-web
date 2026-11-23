import type { DiagnosticFinding, KlippySession, ShutdownDump } from "./types";

export type PersistentUsbRecord = {
  schema: 1;
  action: "add" | "remove" | "start";
  bootId: string;
  epoch: number;
  monotonic: number;
  port: string;
  ids: string;
};

export type PersistentUsbEvidence = PersistentUsbRecord & {
  line: number;
  session: number;
  source: string;
};

export function parsePersistentUsbRecord(line: string): PersistentUsbRecord | null {
  if (line.length > 1024) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["schema", "action", "bootId", "epoch", "monotonic", "port", "ids"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) return null;
  if (record.schema !== 1 || !["add", "remove", "start"].includes(String(record.action))) return null;
  if (typeof record.bootId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.bootId)) return null;
  if ([record.epoch, record.monotonic].some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0)) return null;
  if (typeof record.port !== "string" || typeof record.ids !== "string") return null;
  if (record.action === "start") {
    if (record.port !== "-" || record.ids !== "-") return null;
  } else if (!/^\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,7}$/.test(record.port) || !/^[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}$/.test(record.ids)) return null;
  return record as PersistentUsbRecord;
}

export function persistentUsbMessage(record: PersistentUsbRecord): string {
  const action = record.action === "remove" ? "USB disconnect" : record.action === "add" ? "USB connect" : "USB logger started";
  return `${action} on usb ${record.port}; IDs ${record.ids}; boot ${record.bootId}; epoch=${record.epoch} eventtime=${record.monotonic}`;
}

export function correlatePersistentUsbEvidence(
  records: PersistentUsbEvidence[],
  sessions: KlippySession[],
  dumps: ShutdownDump[],
  findings: DiagnosticFinding[],
) {
  for (const dump of dumps) {
    const lostMcu = /Lost communication with MCU '([^']+)'/i.exec(dump.reason)?.[1];
    if (!lostMcu || dump.time === null || dump.mcus.some((mcu) => mcu.name === lostMcu)) continue;
    const session = sessions.find((candidate) => candidate.number === dump.session);
    if (session?.startSystemTime == null || session.startMonotonicTime === null) continue;
    const offset = session.startSystemTime - session.startMonotonicTime;
    // Klippy does not log a boot UUID. Require a unique boot whose wall/monotonic
    // clock anchor agrees with its start. Missing/ambiguous anchors stay unlinked.
    const boots = new Set(records.filter((record) => Math.abs(record.epoch - record.monotonic - offset) <= 5).map((record) => record.bootId));
    if (boots.size !== 1) continue;
    const [boot] = boots;
    const nearby = records.filter((record) => record.action === "remove" && record.bootId === boot
      && Math.abs(record.monotonic - dump.time!) <= 15);
    if (!nearby.length || new Set(nearby.map((record) => record.port)).size !== 1) continue;
    const finding = findings.find((item) => item.session === dump.session
      && item.id.startsWith("shutdown-dump-lost-mcu-")
      && item.evidence.some((item) => item.source === dump.source && item.line === dump.line));
    if (!finding) continue;
    const port = nearby[0].port;
    finding.detail += ` Persistent USB evidence records a disconnect on usb ${port} within 15 seconds of this shutdown. The Klipper start clock anchor matches one retained boot (${boot}); correlation uses monotonic time within that boot. This supports a USB disappearance or controller reset, and does not establish a power-supply fault or identify the MCU by itself.`;
    finding.checks.unshift(`Confirm that retained USB port ${port} belonged to ${lostMcu} during that boot; a capture after reboot may have a different USB topology.`);
    finding.evidence.push(...nearby.slice(0, 4).map((record) => ({
      line: record.line,
      message: persistentUsbMessage(record),
      session: record.session,
      source: record.source,
      time: record.monotonic,
    })));
  }
}
