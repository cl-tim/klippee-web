import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { repositoryFilesRevision } from "../../repositoryRevision";
import { useWorkspaceConflict, type ConflictWorkspaceSnapshot } from "./useWorkspaceConflict";
import type { ConfigFile } from "../../types";

const file = (path: string, content: string): ConfigFile => ({ path, content, role: "printer", public: false });
const base = [file("printer.cfg", "# baseline\n"), file("macros.cfg", "# baseline macro\n")];
const local = [file("printer.cfg", "# local\n"), base[1]];
const cloud = [base[0], file("macros.cfg", "# cloud macro\n")];
async function response(files = cloud) {
  return Response.json({ versions: [], desired: { files, revision: await repositoryFilesRevision(files), createdAt: "2026-11-02T00:00:00Z", pending: true, source: "web-editor", versionId: null, versionNumber: 0 } });
}
async function setup() {
  let snapshot: ConflictWorkspaceSnapshot = { scope: "u1:p1:r1", repositoryId: "r1", generation: 1,
    files: local, baselineFiles: base, baselineRevision: await repositoryFilesRevision(base) };
  const stage = vi.fn(async () => true), adopt = vi.fn();
  const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ scope }) => useWorkspaceConflict({ scope, getSnapshot: () => snapshot, stage, adopt }), { initialProps: { scope: snapshot.scope } });
  return { ...hook, stage, adopt, fetch, change: (patch: Partial<ConflictWorkspaceSnapshot>) => { snapshot = { ...snapshot, ...patch }; } };
}
afterEach(() => vi.unstubAllGlobals());

it("reviews without mutation, then stages independent changes against freshly checked cloud contents", async () => {
  const h = await setup();
  await act(() => h.result.current.reviewWorkspaceConflict());
  expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled();
  await act(() => h.result.current.resolveWorkspaceConflict({}));
  const merged = [cloud[1], local[0]];
  expect(h.stage).toHaveBeenCalledWith("r1", merged, await repositoryFilesRevision(cloud));
  expect(h.adopt).toHaveBeenCalledWith(merged, await repositoryFilesRevision(merged));
  expect(h.result.current.workspaceConflictReview).toBeNull();
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it("requires a file choice when both sides edit it", async () => {
  const h = await setup(); h.fetch.mockImplementation(async () => response([file("printer.cfg", "# cloud\n"), base[1]]));
  await act(() => h.result.current.reviewWorkspaceConflict());
  await act(() => h.result.current.resolveWorkspaceConflict({}));
  expect(h.stage).not.toHaveBeenCalled(); expect(h.result.current.workspaceConflictStatus).toMatch(/Choose/);
  await act(() => h.result.current.resolveWorkspaceConflict({ "printer.cfg": "local" }));
  expect(h.adopt).toHaveBeenCalled();
});
it("refreshes a changed cloud review and requires another confirmation", async () => {
  const h = await setup(); await act(() => h.result.current.reviewWorkspaceConflict());
  const firstId = h.result.current.workspaceConflictReview?.id;
  h.fetch.mockImplementation(async () => response([file("printer.cfg", "# changed again\n"), cloud[1]]));
  await act(() => h.result.current.resolveWorkspaceConflict({}));
  expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled();
  expect(h.result.current.workspaceConflictReview?.id).not.toBe(firstId);
  expect(h.result.current.workspaceConflictStatus).toMatch(/cloud changed again/);
  expect(h.result.current.workspaceConflictBusy).toBe(false);
});
it("preserves local changes made after opening a review", async () => {
  const h = await setup(); await act(() => h.result.current.reviewWorkspaceConflict()); h.change({ generation: 2 });
  await act(() => h.result.current.resolveWorkspaceConflict({}));
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.stage).not.toHaveBeenCalled();
  expect(h.result.current.workspaceConflictStatus).toMatch(/Local edits changed/);
});
it("discards a review loaded while the workspace was edited", async () => {
  const h = await setup(); let complete!: (value: Response) => void;
  h.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = h.result.current.reviewWorkspaceConflict(); }); h.change({ generation: 2 });
  await act(async () => { complete(await response()); await pending; });
  expect(h.result.current.workspaceConflictReview).toBeNull(); expect(h.adopt).not.toHaveBeenCalled();
});
it("does not replace newer local edits when staging finishes", async () => {
  const h = await setup(); await act(() => h.result.current.reviewWorkspaceConflict());
  let complete!: (value: boolean) => void;
  h.stage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.resolveWorkspaceConflict({}); await vi.waitFor(() => expect(h.stage).toHaveBeenCalled()); });
  h.change({ generation: 2 });
  await act(async () => { complete(true); await pending; });
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.result.current.workspaceConflictStatus).toMatch(/Newer local edits are preserved/);
});
it("does not adopt a late response after switching account or printer", async () => {
  const h = await setup(); await act(() => h.result.current.reviewWorkspaceConflict());
  let complete!: (value: boolean) => void;
  h.stage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.resolveWorkspaceConflict({}); await vi.waitFor(() => expect(h.stage).toHaveBeenCalled()); });
  h.change({ scope: "u2:p2:r2", repositoryId: "r2" }); h.rerender({ scope: "u2:p2:r2" });
  await act(async () => { complete(true); await pending; });
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.result.current.workspaceConflictReview).toBeNull();
});
it("keeps the review and edits when the final revision guard rejects staging", async () => {
  const h = await setup(); h.stage.mockResolvedValue(false);
  await act(() => h.result.current.reviewWorkspaceConflict()); await act(() => h.result.current.resolveWorkspaceConflict({}));
  expect(h.adopt).not.toHaveBeenCalled(); expect(h.result.current.workspaceConflictReview).not.toBeNull();
  expect(h.result.current.workspaceConflictStatus).toMatch(/not confirmed/);
});
it("preserves local state on read failure and on cancel", async () => {
  const h = await setup(); h.fetch.mockRejectedValueOnce(new Error("Offline"));
  await act(() => h.result.current.reviewWorkspaceConflict());
  expect(h.result.current.workspaceConflictStatus).toMatch(/Could not load/);
  await act(() => h.result.current.reviewWorkspaceConflict()); act(() => h.result.current.closeWorkspaceConflictReview());
  expect(h.result.current.workspaceConflictReview).toBeNull(); expect(h.stage).not.toHaveBeenCalled(); expect(h.adopt).not.toHaveBeenCalled();
});

it("refuses an unverified cloud revision", async () => {
  const h = await setup();
  const body = await (await response()).json(); body.desired.revision = "sha256:wrong";
  h.fetch.mockResolvedValueOnce(Response.json(body));
  await act(() => h.result.current.reviewWorkspaceConflict());
  expect(h.result.current.workspaceConflictReview).toBeNull();
  expect(h.result.current.workspaceConflictStatus).toMatch(/could not be verified/);
  expect(h.adopt).not.toHaveBeenCalled();
});

it("requires explicit choices when a historical baseline cannot be recovered", async () => {
  const h = await setup(); h.change({ baselineFiles: undefined, baselineRevision: "sha256:missing" });
  await act(() => h.result.current.reviewWorkspaceConflict());
  expect(h.result.current.workspaceConflictReview?.files.every(file => file.baseline === undefined)).toBe(true);
  await act(() => h.result.current.resolveWorkspaceConflict({}));
  expect(h.stage).not.toHaveBeenCalled();
});
