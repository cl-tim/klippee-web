import type { KlippyLogAnalysis } from "./types";

/**
 * Choose which session scope to show right after an analysis loads.
 *
 * A klippy.log routinely spans several Klipper restarts, and the failure the
 * user came to investigate often lives in an earlier boot while the newest
 * session restarted cleanly. Defaulting to the newest session therefore hides
 * the crash and reads as "no errors found". Instead, land on the session the
 * analysis conclusion points at; if findings exist without a single evidence
 * session, show every session combined so nothing is hidden; only fall back to
 * the newest session when nothing was flagged at all.
 */
export function pickDefaultSession(analysis: KlippyLogAnalysis): string {
  if (analysis.summary.session !== null) return String(analysis.summary.session);
  if (analysis.findings.length) return "all";
  return String(analysis.sessions[analysis.sessions.length - 1]?.number ?? "all");
}
