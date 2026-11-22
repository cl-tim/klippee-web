import { useLayoutEffect, useRef, useState } from "react";
import { cloudFetch } from "../cloudFetch";
import { verifyRepositoryVersionsResponse } from "../responseGuards";
import { repositoryFilesRevision } from "../../repositoryRevision";
import { hasBlockingSafetyFindings, scanConfigFiles } from "../../safety";
import type { ConflictWorkspaceSnapshot } from "./useWorkspaceConflict";
import type { ConfigFile } from "../../types";

export type HistoryFileRestoreReview = {
  snapshot: ConflictWorkspaceSnapshot;
  sourceVersionId: string;
  sourceVersionNumber: number;
  before: ConfigFile | null;
  after: ConfigFile;
  cloudRevision: string | null;
};

export function useHistoryFileRestore(options: {
  scope: string;
  getSnapshot: () => ConflictWorkspaceSnapshot | null;
  pause: () => void;
  conflict: () => void;
  stage: (repositoryId: string, files: ConfigFile[], revision: string | null) => Promise<boolean>;
  adopt: (files: ConfigFile[], revision: string, path: string) => void;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const sequence = useRef(0), running = useRef(false);
  const writing = useRef(false);
  const empty = { review: null, busy: false, status: "" };
  const [state, setState] = useState<{ scope: string; review: HistoryFileRestoreReview | null; busy: boolean; status: string }>({ scope: options.scope, ...empty });
  const { review, busy, status } = state.scope === options.scope ? state : empty;
  function update(patch: Partial<Omit<typeof state, "scope">>) {
    setState(current => ({ ...(current.scope === options.scope ? current : empty), ...patch, scope: options.scope }));
  }
  useLayoutEffect(() => {
    sequence.current += 1; running.current = false; writing.current = false;
    return () => { sequence.current += 1; };
  }, [options.scope]);
  function unchanged(snapshot: ConflictWorkspaceSnapshot, operation: number) {
    const now = latest.current.getSnapshot();
    return sequence.current === operation && now?.scope === snapshot.scope && now.generation === snapshot.generation;
  }
  async function readSource(snapshot: ConflictWorkspaceSnapshot, versionNumber: number, path: string) {
    const result = await cloudFetch(`/api/repos/${encodeURIComponent(snapshot.repositoryId)}/versions?format=content-addressed`, {
      validate: verifyRepositoryVersionsResponse,
    });
    if (!result.ok || !result.data) throw new Error("Could not load recovery history. Local edits are unchanged; try again.");
    const source = result.data.versions.find(version => version.version_number === versionNumber);
    const file = source?.files.find(file => file.path === path);
    if (!source || !file) throw new Error("That recovery point or file is no longer available. Choose another file.");
    const desired = result.data.desired;
    if (desired && await repositoryFilesRevision(desired.files) !== desired.revision) {
      throw new Error("The cloud revision could not be verified. Local edits are unchanged.");
    }
    return { file, sourceVersionId: source.id, revision: desired?.revision ?? null };
  }

  async function reviewHistoryFileRestore(versionNumber: number, path: string) {
    if (running.current) return;
    const snapshot = latest.current.getSnapshot();
    if (!snapshot) { update({ status: "Connect this printer to a cloud repository before restoring a history file." }); return; }
    latest.current.pause();
    running.current = true; const operation = ++sequence.current;
    update({ review: null, busy: true, status: "Loading the recovery file and current cloud revision…" });
    try {
      const source = await readSource(snapshot, versionNumber, path);
      const localRevision = await repositoryFilesRevision(snapshot.files);
      if (!unchanged(snapshot, operation)) { if (sequence.current === operation) update({ status: "The workspace changed. Review the file again to include your newest edits." }); return; }
      if (snapshot.baselineRevision !== source.revision && localRevision !== source.revision) {
        latest.current.conflict();
        update({ status: "The cloud draft changed. Close Recovery and choose Review conflict before restoring this file." }); return;
      }
      update({ review: { snapshot, sourceVersionId: source.sourceVersionId, sourceVersionNumber: versionNumber,
        before: snapshot.files.find(file => file.path === path) ?? null, after: source.file, cloudRevision: source.revision },
        status: "Review the replacement below. Other draft files are kept; nothing is staged until you confirm." });
    } catch (error) {
      if (sequence.current === operation) update({ status: error instanceof Error ? error.message : "Recovery review failed. Local edits are unchanged." });
    } finally { if (sequence.current === operation) { running.current = false; update({ busy: false }); } }
  }

  async function confirmHistoryFileRestore() {
    if (!review || running.current) return;
    const operation = sequence.current;
    if (!unchanged(review.snapshot, operation)) { update({ status: "Local edits changed after this preview. Review the file again before confirming." }); return; }
    const files = review.snapshot.files.some(file => file.path === review.after.path)
      ? review.snapshot.files.map(file => file.path === review.after.path ? review.after : file)
      : [...review.snapshot.files, review.after];
    if (hasBlockingSafetyFindings(scanConfigFiles(files))) { update({ status: "The resulting draft has blocking safety findings. Keep editing locally to resolve them before staging." }); return; }
    running.current = true; update({ busy: true, status: "Rechecking the recovery file and cloud revision…" });
    try {
      const source = await readSource(review.snapshot, review.sourceVersionNumber, review.after.path);
      if (!unchanged(review.snapshot, operation)) { if (sequence.current === operation) update({ status: "The workspace changed. Newer local edits are preserved; review again." }); return; }
      if (source.sourceVersionId !== review.sourceVersionId || JSON.stringify(source.file) !== JSON.stringify(review.after)) {
        update({ review: null, status: "The recovery source changed. Review the file again before restoring it." }); return;
      }
      if (source.revision !== review.cloudRevision) {
        latest.current.conflict();
        update({ review: null, status: "The cloud draft changed during review. Close Recovery and choose Review conflict before restoring this file." }); return;
      }
      const revision = await repositoryFilesRevision(files);
      if (!unchanged(review.snapshot, operation)) return;
      writing.current = true;
      const saved = await latest.current.stage(review.snapshot.repositoryId, files, source.revision);
      if (!unchanged(review.snapshot, operation)) { if (sequence.current === operation) { latest.current.conflict(); update({ status: "The workspace changed during staging. Newer local edits are preserved; review the cloud conflict before continuing." }); } return; }
      if (!saved) { latest.current.conflict(); update({ status: "Restore was not confirmed. Local edits are preserved. Review the cloud conflict before retrying." }); return; }
      latest.current.adopt(files, revision, review.after.path);
      update({ review: null, status: `Restored ${review.after.path} from recovery point ${review.sourceVersionNumber} to the pending draft. Apply it on the printer when ready.` });
    } catch (error) {
      if (sequence.current === operation) update({ status: error instanceof Error ? error.message : "Restore failed. Local edits are unchanged." });
    } finally { if (sequence.current === operation) { running.current = false; writing.current = false; update({ busy: false }); } }
  }
  function cancelHistoryFileRestore(force = false) {
    if (running.current && !force) return;
    if (writing.current && latest.current.getSnapshot()?.scope === review?.snapshot.scope) latest.current.conflict();
    sequence.current += 1;
    running.current = false; writing.current = false;
    update({ review: null, busy: false, status: "" });
  }
  return { historyFileRestoreReview: review, historyFileRestoreBusy: busy, historyFileRestoreStatus: status,
    reviewHistoryFileRestore, confirmHistoryFileRestore, cancelHistoryFileRestore };
}
