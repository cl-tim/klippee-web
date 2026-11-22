import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStorageProvider } from "../contexts/AccountStorageContext";
import { repositoryFilesRevision } from "../../repositoryRevision";
import type { HistoryVersion, PrinterState } from "../../types";
import type { PrinterRecord } from "../types";
import { useRepositorySync } from "./useRepositorySync";
import { TestUiProvider } from "../../test/uiTestUtils";

const files = [{
  content: "[printer]\nmax_velocity: 300\n",
  path: "printer.cfg",
  public: false,
  role: "printer",
}];

const latestVersion: HistoryVersion = {
  createdAt: "2026-08-04T00:00:00.000Z",
  files,
  id: 4,
  message: "Applied config",
  previousId: 3,
  source: "capture",
};

const selectedPrinter: PrinterRecord = {
  appliedVersionId: 4,
  createdAt: "2026-08-04T00:00:00.000Z",
  description: "",
  id: "printer-1",
  latestVersionId: 4,
  make: "",
  model: "",
  name: "Printer 1",
  packageIds: [],
  repositoryId: "repo-1",
  source: "manual",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const printer: PrinterState = {
  appliedVersionId: 4,
  lastSeen: "",
  latestVersionId: 4,
  name: "Printer 1",
};

function options(overrides: Partial<Parameters<typeof useRepositorySync>[0]> = {}) {
  return {
    activeRepositoryId: "repo-1",
    authUser: { avatarUrl: null, displayName: "Tester", id: "user-1", providers: [] },
    bindRepositoryToSelectedPrinter: vi.fn(),
    latestVersion,
    printer,
    selectedPrinter,
    setPrinter: vi.fn(),
    setPrinters: vi.fn(),
    setRepoStatus: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof useRepositorySync>[0];
}

function accountStorageWrapper({ children }: { children: ReactNode }) {
  return createElement(TestUiProvider, { children: createElement(AccountStorageProvider, { children, userId: "user-1" }) });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser repository draft staging", () => {
  it("keeps review paused when a previously queued save acknowledges late", async () => {
    let complete!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const setPrinters = vi.fn();
    const { result } = renderHook(() => useRepositorySync(options({ activeRepositoryId: null,
      selectedPrinter: { ...selectedPrinter, workspaceBaseRevision: "sha256:base" }, setPrinters })), { wrapper: accountStorageWrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.stageRepositoryConfig("repo-1", files); });
    act(() => result.current.pauseSyncForReview());
    await act(async () => { complete(Response.json({ desired: { createdAt: "2026-11-02T00:00:00Z", revision: "sha256:late" } })); await pending; });
    expect(result.current.syncConflict).toBe(true);
    expect(setPrinters).not.toHaveBeenCalled();
  });

  it("stages a reviewed result with the fresh revision but leaves conflict recovery to its adopter", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: "desired_configuration_conflict" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ desired: { createdAt: "2026-11-02T00:00:00Z", revision: "sha256:reviewed" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRepositorySync(options({ activeRepositoryId: null })), { wrapper: accountStorageWrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    await act(() => result.current.stageRepositoryConfig("repo-1", files));
    expect(result.current.syncConflict).toBe(true);
    await act(() => result.current.stageRepositoryConfig("repo-1", files, { baseRevision: "sha256:fresh-cloud" }));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).baseRevision).toBe("sha256:fresh-cloud");
    expect(result.current.syncConflict).toBe(true);
    act(() => result.current.clearSyncConflict());
    expect(result.current.syncConflict).toBe(false);
  });

  it("ignores a late older stage response after a newer conflict", async () => {
    let complete!: (value: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce(Response.json({ code: "desired_configuration_conflict" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const setPrinters = vi.fn();
    const { result } = renderHook(() => useRepositorySync(options({ activeRepositoryId: null,
      selectedPrinter: { ...selectedPrinter, workspaceBaseRevision: "sha256:base" }, setPrinters })), { wrapper: accountStorageWrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    let older!: Promise<boolean>;
    act(() => { older = result.current.stageRepositoryConfig("repo-1", files); });
    await act(() => result.current.stageRepositoryConfig("repo-1", files));
    expect(result.current.syncConflict).toBe(true);
    await act(async () => { complete(Response.json({ desired: { createdAt: "2026-11-02T00:00:00Z", revision: "sha256:older" } })); await older; });
    expect(result.current.syncConflict).toBe(true);
    expect(setPrinters).not.toHaveBeenCalled();
  });

  it("sends the saved workspace baseline and advances it after success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        desired: { createdAt: "2026-08-04T00:01:00.000Z", revision: "sha256:first-draft" },
      }), { headers: { "content-type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        desired: { createdAt: "2026-08-04T00:02:00.000Z", revision: "sha256:second-draft" },
      }), { headers: { "content-type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRepositorySync(options({
      activeRepositoryId: null,
      selectedPrinter: { ...selectedPrinter, workspaceBaseRevision: "sha256:restored-baseline" },
    })), { wrapper: accountStorageWrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    vi.useFakeTimers();

    await act(async () => {
      await result.current.stageRepositoryConfig("repo-1", files);
      await result.current.stageRepositoryConfig("repo-1", [{ ...files[0], content: "max_velocity: 350\n" }]);
    });

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(firstBody.baseRevision).toBe("sha256:restored-baseline");
    expect(secondBody.baseRevision).toBe("sha256:first-draft");
  });

  it("uses immutable history as a safe legacy baseline and exposes conflicts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "desired_configuration_conflict",
      current: { revision: "sha256:newer-desktop-draft" },
    }), { headers: { "content-type": "application/json" }, status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const setRepoStatus = vi.fn();
    const { result } = renderHook(() => useRepositorySync(options({ activeRepositoryId: null, setRepoStatus })), {
      wrapper: accountStorageWrapper,
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    vi.useFakeTimers();

    await act(async () => {
      await result.current.stageRepositoryConfig("repo-1", [{ ...files[0], content: "stale restored edit" }]);
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.baseRevision).toBe(await repositoryFilesRevision(latestVersion.files));
    expect(setRepoStatus).toHaveBeenCalledWith(expect.stringContaining("Draft conflict"));
  });
});
