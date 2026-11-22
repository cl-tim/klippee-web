import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { repositoryFilesRevision } from "../../repositoryRevision";
import { useHistoryFileRestore } from "./useHistoryFileRestore";
import type { ConflictWorkspaceSnapshot } from "./useWorkspaceConflict";
import type { ConfigFile } from "../../types";

const file = (path: string, content: string): ConfigFile => ({ path, content, public: false, role: "printer" });
const baseline = [file("printer.cfg", "# current\n"), file("macros.cfg", "# current macro\n")];
const local = [baseline[0], file("macros.cfg", "# unsaved local macro\n")];
const recovery = file("printer.cfg", "# recovery\n");
async function response(current = baseline, source: ConfigFile[] = [recovery], sourceId = "version-1") {
  return Response.json({ desired: { files: current, revision: await repositoryFilesRevision(current), createdAt: "2026-11-02T00:00:00Z", pending: true, source: "web-editor", versionId: null, versionNumber: 2 },
    versions: [{ id: sourceId, version_number: 1, files: source, created_at: "2026-11-01T00:00:00Z", previous_version_id: null, message: "Recovery", source: "capture" }] });
}
async function setup() {
  let snapshot: ConflictWorkspaceSnapshot = { scope: "u1:p1:r1", repositoryId: "r1", generation: 1,
    files: local, baselineRevision: await repositoryFilesRevision(baseline), baselineFiles: baseline };
  const stage = vi.fn(async () => true), adopt = vi.fn(), pause = vi.fn(), conflict = vi.fn();
  const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ scope }) => useHistoryFileRestore({ scope, getSnapshot: () => snapshot, stage, adopt, pause, conflict }), { initialProps: { scope: snapshot.scope } });
  return { ...hook, stage, adopt, pause, conflict, fetch, change: (patch: Partial<ConflictWorkspaceSnapshot>) => { snapshot = { ...snapshot, ...patch }; } };
}
afterEach(() => vi.unstubAllGlobals());

it("only stages the selected replacement after confirmation, retaining unrelated unsaved files", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  expect(h.result.current.historyFileRestoreReview).toMatchObject({ before: baseline[0], after: recovery });
  expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled();
  await act(() => h.result.current.confirmHistoryFileRestore());
  const expected = [recovery, local[1]];
  expect(h.stage).toHaveBeenCalledWith("r1", expected, await repositoryFilesRevision(baseline));
  expect(h.adopt).toHaveBeenCalledWith(expected, await repositoryFilesRevision(expected), "printer.cfg");
  expect(h.conflict).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledTimes(2);
});
it("adds a recovery file absent from the current draft", async () => {
  const h = await setup(); h.change({ files: [local[1]] });
  await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  expect(h.result.current.historyFileRestoreReview?.before).toBeNull();
  await act(() => h.result.current.confirmHistoryFileRestore());
  expect(h.stage).toHaveBeenCalledWith("r1", [local[1], recovery], await repositoryFilesRevision(baseline));
});
it("cancels without a write or changing the workspace", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  act(() => h.result.current.cancelHistoryFileRestore());
  expect(h.result.current.historyFileRestoreReview).toBeNull(); expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled(); expect(h.conflict).not.toHaveBeenCalled();
});
it.each(["missing", "changed"])("rejects a %s recovery source at confirmation", async kind => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  h.fetch.mockImplementation(async () => response(baseline, kind === "missing" ? [] : [file("printer.cfg", "# changed source\n")]));
  await act(() => h.result.current.confirmHistoryFileRestore());
  expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled(); expect(h.result.current.historyFileRestoreStatus).toMatch(/no longer available|source changed/);
});
it("routes a cloud change during review to conflict resolution instead of overwriting it", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  h.fetch.mockImplementation(async () => response([file("printer.cfg", "# concurrent capture\n"), baseline[1]]));
  await act(() => h.result.current.confirmHistoryFileRestore());
  expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled(); expect(h.conflict).toHaveBeenCalledOnce();
});
it("refuses to review over an unresolved cloud conflict", async () => {
  const h = await setup(); h.change({ baselineRevision: "sha256:stale" });
  await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  expect(h.result.current.historyFileRestoreReview).toBeNull(); expect(h.conflict).toHaveBeenCalledOnce(); expect(h.stage).not.toHaveBeenCalled();
});
it("requires a fresh preview after local edits", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg")); h.change({ generation: 2 });
  await act(() => h.result.current.confirmHistoryFileRestore());
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.stage).not.toHaveBeenCalled(); expect(h.result.current.historyFileRestoreStatus).toMatch(/Local edits changed/);
});
it("preserves newer local edits when a confirmed stage completes late", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  let complete!: (value: boolean) => void;
  h.stage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.confirmHistoryFileRestore(); await vi.waitFor(() => expect(h.stage).toHaveBeenCalled()); });
  h.change({ generation: 2 }); await act(async () => { complete(true); await pending; });
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.conflict).toHaveBeenCalledOnce();
});
it("preserves edits and pauses on an unconfirmed revision-guarded write", async () => {
  const h = await setup(); h.stage.mockResolvedValue(false);
  await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg")); await act(() => h.result.current.confirmHistoryFileRestore());
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.conflict).toHaveBeenCalledOnce(); expect(h.result.current.historyFileRestoreStatus).toMatch(/not confirmed/);
});
it("ignores a read completed after leaving Recovery", async () => {
  const h = await setup(); let complete!: (value: Response) => void;
  h.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>; act(() => { pending = h.result.current.reviewHistoryFileRestore(1, "printer.cfg"); });
  act(() => h.result.current.cancelHistoryFileRestore(true));
  await act(async () => { complete(await response()); await pending; });
  expect(h.result.current.historyFileRestoreReview).toBeNull(); expect(h.result.current.historyFileRestoreBusy).toBe(false); expect(h.conflict).not.toHaveBeenCalled();
});
it("pauses an uncertain write when Recovery unmounts", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  let complete!: (value: boolean) => void;
  h.stage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.confirmHistoryFileRestore(); await vi.waitFor(() => expect(h.stage).toHaveBeenCalled()); });
  act(() => h.result.current.cancelHistoryFileRestore(true));
  await act(async () => { complete(true); await pending; });
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.conflict).toHaveBeenCalledOnce(); expect(h.result.current.historyFileRestoreReview).toBeNull();
});
it("ignores a late response after switching account or printer", async () => {
  const h = await setup(); await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  let complete!: (value: boolean) => void;
  h.stage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.confirmHistoryFileRestore(); await vi.waitFor(() => expect(h.stage).toHaveBeenCalled()); });
  h.change({ scope: "u2:p2:r2", repositoryId: "r2" }); h.rerender({ scope: "u2:p2:r2" });
  await act(async () => { complete(true); await pending; });
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.result.current.historyFileRestoreReview).toBeNull();
});
it("retains local state when the read fails", async () => {
  const h = await setup(); h.fetch.mockRejectedValueOnce(new Error("Offline"));
  await act(() => h.result.current.reviewHistoryFileRestore(1, "printer.cfg"));
  expect(h.result.current.historyFileRestoreStatus).toMatch(/Could not load/); expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled();
});
