import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialPrinter } from "../../data";
import type { HistoryVersion } from "../../types";
import type { PrinterRecord } from "../types";
import {
  buildCloudAppState,
  cloudAppStateMaxBytes,
  cloudAppStatePayloadBytes,
  cloudAppStatesEqual,
  useCloudAppState,
} from "./useCloudAppState";

const configVersion = (id: number, content: string): HistoryVersion => ({
  createdAt: `2026-07-${String(id).padStart(2, "0")}T00:00:00.000Z`,
  files: [{ content, path: "printer.cfg", public: false, role: "printer" }],
  id,
  message: `Version ${id}`,
  previousId: id > 1 ? id - 1 : null,
  source: "capture",
});

const printer = (overrides: Partial<PrinterRecord> = {}): PrinterRecord => ({
  appliedVersionId: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  description: "",
  id: "printer-1",
  latestVersionId: 2,
  make: "",
  model: "",
  name: "Printer 1",
  packageIds: [],
  repositoryId: "repo-1",
  source: "manual",
  updatedAt: "2026-07-22T00:00:00.000Z",
  variableValues: {},
  workspaceFilePath: "printer.cfg",
  ...overrides,
});

function snapshot(overrides: Record<string, unknown> = {}) {
  const history = [configVersion(1, "A".repeat(300_000)), configVersion(2, "B".repeat(300_000))];
  return {
    currentWorkspaceContent: "[printer]\nmax_velocity: 400\n",
    history,
    printer: initialPrinter,
    printers: [printer({ history })],
    repositoryId: "repo-1",
    selectedCompanionAssetId: "",
    selectedFilePath: "printer.cfg",
    selectedPackageId: "",
    selectedPrinterId: "printer-1",
    workspaceFilePath: "printer.cfg",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud app-state autosave", () => {
  it("waits for the returned revision to persist before finishing the save", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    const flushLocalState = vi.fn().mockReturnValue(persistence);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, revision: "a".repeat(64) }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCloudAppState({
      authUser: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      cloudStateReady: true,
      ...snapshot(),
      flushLocalState,
      setCloudStatus: vi.fn(),
      setDraftSavedAt: vi.fn(),
      workspaceChanged: false,
      workspaceDrafts: {},
    }));
    let finished = false;
    const saving = result.current.saveCloudState().then(() => { finished = true; });
    await waitFor(() => expect(flushLocalState).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    finishPersistence();
    await act(async () => { await saving; });
    expect(finished).toBe(true);
  });

  it("recognizes an identical saved snapshot when only property order differs", () => {
    const first = buildCloudAppState(snapshot());
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as typeof first;
    expect(cloudAppStatesEqual(first, reordered)).toBe(true);
    expect(cloudAppStatesEqual(first, { ...reordered, workspaceContent: "another edit" })).toBe(false);
    expect(cloudAppStatesEqual(first, null)).toBe(false);
  });

  it("serializes saves and uses the revision returned by the previous save", async () => {
    let finishFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { finishFirst = resolve; });
    const revisionA = "a".repeat(64);
    const revisionB = "b".repeat(64);
    const revisionC = "c".repeat(64);
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revision: revisionC }), {
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onCloudRevision = vi.fn();
    const { result } = renderHook(() => useCloudAppState({
      authUser: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      cloudStateReady: true,
      ...snapshot(),
      initialCloudRevision: revisionA,
      onCloudRevision,
      setCloudStatus: vi.fn(),
      setDraftSavedAt: vi.fn(),
      workspaceChanged: false,
      workspaceDrafts: {},
    }));
    const first = result.current.saveCloudState("manual", { currentWorkspaceContent: "first edit" });
    const second = result.current.saveCloudState("manual", { currentWorkspaceContent: "newer edit" });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishFirst(new Response(JSON.stringify({ ok: true, revision: revisionB }), {
      headers: { "content-type": "application/json" },
    }));
    await act(async () => { await Promise.all([first, second]); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(requests[0]).toMatchObject({ expectedRevision: revisionA, state: { workspaceContent: "first edit" } });
    expect(requests[1]).toMatchObject({ expectedRevision: revisionB, state: { workspaceContent: "newer edit" } });
    expect(onCloudRevision).toHaveBeenLastCalledWith(revisionC);
  });

  it("does not acknowledge an autosave when the local write failed", async () => {
    vi.useFakeTimers();
    const setDraftSavedAt = vi.fn();
    const setCloudStatus = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useCloudAppState({
      authUser: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      cloudStateReady: true,
      ...snapshot(),
      flushLocalState: vi.fn().mockRejectedValue(new Error("Browser storage is full")),
      setCloudStatus,
      setDraftSavedAt,
      workspaceChanged: true,
      workspaceDrafts: { "printer.cfg": "unsaved edit" },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(setDraftSavedAt.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCloudStatus).toHaveBeenCalledWith("Draft remains open; saving on this device failed");
  });

  it("omits repository history already stored by dedicated APIs", () => {
    const sensitiveValue = "never-send-this-printer-secret";
    const state = buildCloudAppState(snapshot({
      printers: [printer({ variableValues: { api_token: sensitiveValue }, workspaceBaseFiles: configVersion(1, "local-baseline-sentinel").files })],
    }));

    expect(state.history).toEqual([]);
    expect(state.printers?.[0].history).toBeUndefined();
    expect(state.printers?.[0]).not.toHaveProperty("variableValues");
    expect(state).not.toHaveProperty("values");
    expect(state).not.toHaveProperty("privatePackages");
    expect(state).not.toHaveProperty("companionAssets");
    expect(JSON.stringify(state)).not.toContain(sensitiveValue);
    expect(state.printers?.[0]).not.toHaveProperty("workspaceBaseFiles");
    expect(JSON.stringify(state)).not.toContain("local-baseline-sentinel");
    expect(cloudAppStatePayloadBytes(state)).toBeLessThan(cloudAppStateMaxBytes);
  });

  it("retains only the latest history entry for a local-only printer", () => {
    const history = [configVersion(1, "first"), configVersion(2, "latest")];
    const state = buildCloudAppState(snapshot({
      history,
      printers: [printer({ history, repositoryId: null })],
      repositoryId: null,
    }));

    expect(state.history.map((version) => version.id)).toEqual([2]);
    expect(state.printers?.[0].history?.map((version) => version.id)).toEqual([2]);
  });

  it("keeps oversized drafts local instead of sending a guaranteed 413 request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const setCloudStatus = vi.fn();
    const largeWorkspaceContent = "€".repeat(180_000);

    renderHook(() => useCloudAppState({
      authUser: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      cloudStateReady: true,
      ...snapshot({ currentWorkspaceContent: largeWorkspaceContent }),
      setCloudStatus,
      setDraftSavedAt: vi.fn(),
      workspaceChanged: true,
      workspaceDrafts: { "printer.cfg": largeWorkspaceContent },
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_400);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCloudStatus).toHaveBeenCalledWith("Draft saved locally; too large for cloud autosave");
  });

  it("saves an explicitly committed snapshot instead of stale render state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const committedVersion = configVersion(3, "max_accel: ${KLIPPEE:browser_qa_accel}");
    const { result } = renderHook(() => useCloudAppState({
      authUser: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      cloudStateReady: true,
      ...snapshot(),
      setCloudStatus: vi.fn(),
      setDraftSavedAt: vi.fn(),
      workspaceChanged: false,
      workspaceDrafts: {},
    }));

    await act(async () => {
      await result.current.saveCloudState("manual", {
        currentWorkspaceContent: committedVersion.files[0].content,
        history: [configVersion(1, "first"), configVersion(2, "second"), committedVersion],
        printers: [printer({ variableValues: { browser_qa_accel: "2700" } })],
        repositoryId: null,
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(request.body)) as { state: {
      history: HistoryVersion[];
      printers: PrinterRecord[];
      workspaceContent: string;
    } };
    expect(payload.state.history.map((version) => version.id)).toEqual([3]);
    expect(payload.state).not.toHaveProperty("values");
    expect(payload.state.printers[0]).not.toHaveProperty("variableValues");
    expect(payload.state.workspaceContent).toContain("${KLIPPEE:browser_qa_accel}");
  });
});
