import { useLayoutEffect, useRef, useState } from "react";
import { cloudFetch } from "../cloudFetch";
import { verifyRepositoryVersionsResponse } from "../responseGuards";
import { repositoryFilesRevision } from "../../repositoryRevision";
import { hasBlockingSafetyFindings, scanConfigFiles } from "../../safety";
import { resolveWorkspaceFiles, reviewWorkspaceFiles, type WorkspaceFileChoice } from "../workspaceConflict";
import type { ConfigFile } from "../../types";

export type ConflictWorkspaceSnapshot = {
  scope: string;
  repositoryId: string;
  generation: number;
  files: ConfigFile[];
  baselineRevision: string | null | undefined;
  baselineFiles?: ConfigFile[];
};
export type WorkspaceConflictReview = {
  id: number;
  snapshot: ConflictWorkspaceSnapshot;
  cloudRevision: string | null;
  files: ReturnType<typeof reviewWorkspaceFiles>;
};

export function useWorkspaceConflict(options: {
  scope: string;
  getSnapshot: () => ConflictWorkspaceSnapshot | null;
  stage: (repositoryId: string, files: ConfigFile[], revision: string | null) => Promise<boolean>;
  adopt: (files: ConfigFile[], revision: string) => void;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const sequence = useRef(0), running = useRef(false);
  const empty = { review: null, busy: false, status: "" };
  const [state, setState] = useState<{ scope: string; review: WorkspaceConflictReview | null; busy: boolean; status: string }>({ scope: options.scope, ...empty });
  const { review, busy, status } = state.scope === options.scope ? state : empty;
  function update(patch: Partial<Omit<typeof state, "scope">>) {
    setState(current => ({ ...(current.scope === options.scope ? current : empty), ...patch, scope: options.scope }));
  }
  const setReview = (value: WorkspaceConflictReview | null) => update({ review: value });
  const setBusy = (value: boolean) => update({ busy: value });
  const setStatus = (value: string) => update({ status: value });
  useLayoutEffect(() => {
    sequence.current += 1; running.current = false;
    return () => { sequence.current += 1; };
  }, [options.scope]);

  function unchanged(snapshot: ConflictWorkspaceSnapshot, operation: number) {
    const now = latest.current.getSnapshot();
    return sequence.current === operation && now?.scope === snapshot.scope && now.generation === snapshot.generation;
  }

  async function readCloud(snapshot: ConflictWorkspaceSnapshot) {
    const response = await cloudFetch(`/api/repos/${encodeURIComponent(snapshot.repositoryId)}/versions?format=content-addressed`, {
      validate: verifyRepositoryVersionsResponse,
    });
    if (!response.ok || !response.data) throw new Error("Could not load the current configuration. Local edits are unchanged; try reviewing again.");
    const { desired, versions } = response.data;
    const cloudFiles = desired?.files ?? [];
    if (desired && await repositoryFilesRevision(cloudFiles) !== desired.revision) {
      throw new Error("The cloud configuration revision could not be verified. Local edits are unchanged.");
    }
    const baselineRevision = snapshot.baselineRevision === undefined && snapshot.baselineFiles
      ? await repositoryFilesRevision(snapshot.baselineFiles) : snapshot.baselineRevision;
    let baseline: ConfigFile[] | null = baselineRevision === null ? [] : null;
    if (snapshot.baselineFiles && await repositoryFilesRevision(snapshot.baselineFiles) === baselineRevision) baseline = snapshot.baselineFiles;
    if (!baseline && baselineRevision) {
      for (const version of versions) {
        if (await repositoryFilesRevision(version.files) === baselineRevision) { baseline = version.files; break; }
      }
    }
    return { cloudRevision: desired?.revision ?? null, files: reviewWorkspaceFiles(baseline, snapshot.files, cloudFiles) };
  }

  async function reviewWorkspaceConflict() {
    if (running.current) return;
    const snapshot = latest.current.getSnapshot();
    if (!snapshot) return;
    running.current = true; setBusy(true); setStatus("Loading current cloud files; local edits are unchanged.");
    const operation = ++sequence.current;
    try {
      const cloud = await readCloud(snapshot);
      if (!unchanged(snapshot, operation)) {
        if (sequence.current === operation) setStatus("The workspace changed while loading. Review again to include your newest edits.");
        return;
      }
      setReview({ id: operation, snapshot, ...cloud });
      setStatus("Review each file, then confirm the result. Nothing is staged until you confirm.");
    } catch (error) {
      if (sequence.current === operation) setStatus(error instanceof Error ? error.message : "Review failed. Local edits are unchanged.");
    } finally {
      if (sequence.current === operation) { running.current = false; setBusy(false); }
    }
  }

  async function resolveWorkspaceConflict(choices: Record<string, WorkspaceFileChoice>) {
    if (!review || running.current) return;
    const files = resolveWorkspaceFiles(review.files, choices);
    if (!files) { setStatus("Choose a local or cloud result for every conflicting file."); return; }
    if (!files.length) { setStatus("Keep at least one configuration file before staging. Local edits are unchanged."); return; }
    if (hasBlockingSafetyFindings(scanConfigFiles(files))) { setStatus("The reviewed result has blocking safety findings. Keep editing locally to resolve them before staging."); return; }
    const operation = sequence.current;
    if (!unchanged(review.snapshot, operation)) { setStatus("Local edits changed after this review. Review again before staging."); return; }
    running.current = true; setBusy(true); setStatus("Checking the latest cloud revision before staging…");
    try {
      const cloud = await readCloud(review.snapshot);
      if (!unchanged(review.snapshot, operation)) { if (sequence.current === operation) setStatus("The workspace changed. Local edits are preserved; review again."); return; }
      if (cloud.cloudRevision !== review.cloudRevision) {
        const id = ++sequence.current;
        setReview({ id, snapshot: review.snapshot, ...cloud });
        setStatus("The cloud changed again. Review the refreshed files and confirm your choices again.");
        running.current = false; setBusy(false); return;
      }
      const revision = await repositoryFilesRevision(files);
      if (!unchanged(review.snapshot, operation)) return;
      const saved = await latest.current.stage(review.snapshot.repositoryId, files, cloud.cloudRevision);
      if (!unchanged(review.snapshot, operation)) { if (sequence.current === operation) setStatus("The workspace changed during staging. Newer local edits are preserved; review the latest cloud result again."); return; }
      if (!saved) { setStatus("The result was not confirmed. Local edits are preserved; review the latest cloud files before retrying."); return; }
      latest.current.adopt(files, revision);
      setReview(null); setStatus("Reviewed configuration staged for printer apply.");
    } catch (error) {
      if (sequence.current === operation) setStatus(error instanceof Error ? error.message : "Resolution failed. Local edits are unchanged.");
    } finally {
      if (sequence.current === operation) { running.current = false; setBusy(false); }
    }
  }

  function closeWorkspaceConflictReview() {
    if (!running.current) { setReview(null); setStatus("Review closed. Local edits are preserved and sync remains paused."); }
  }
  return { workspaceConflictReview: review, workspaceConflictBusy: busy, workspaceConflictStatus: status,
    reviewWorkspaceConflict, resolveWorkspaceConflict, closeWorkspaceConflictReview };
}
