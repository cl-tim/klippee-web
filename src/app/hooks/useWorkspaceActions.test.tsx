import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConfigFile } from "../../types";
import { AccountStorageProvider } from "../contexts/AccountStorageContext";
import { useWorkspaceActions } from "./useWorkspaceActions";
import { TestUiProvider } from "../../test/uiTestUtils";

const file = (path: string, content: string): ConfigFile => ({
  content,
  path,
  public: false,
  role: "printer",
});

describe("workspace config imports", () => {
  it("cancels a file read when the active printer and workspace change", async () => {
    let currentContext = {
      generation: 2,
      ownerPrinterId: "printer-A",
      selectedPrinterId: "printer-A",
    };
    let finishRead!: (content: string) => void;
    const pendingConfigImport = vi.fn();
    const setBuildStatus = vi.fn();
    const setWorkspaceDraftFiles = vi.fn();
    const delayedFile = {
      name: "from-a.cfg",
      size: 12,
      text: () => new Promise<string>((resolve) => { finishRead = resolve; }),
    } as File;
    const wrapper = ({ children }: React.PropsWithChildren) => (
      <TestUiProvider><AccountStorageProvider userId={null}>{children}</AccountStorageProvider></TestUiProvider>
    );
    const { result, rerender } = renderHook(
      ({ activeFiles, printerId }: { activeFiles: ConfigFile[]; printerId: string }) => useWorkspaceActions({
        currentWorkspaceFile: activeFiles[0] ?? null,
        pendingConfigImport: null,
        pendingWorkspaceFiles: activeFiles,
        selectedPrinter: { id: printerId, name: printerId },
        setBuildStatus,
        setPackageDraft: () => {},
        setPendingConfigImport: pendingConfigImport,
        setWorkspaceContent: vi.fn(),
        setWorkspaceDrafts: vi.fn(),
        setWorkspaceDraftFiles,
        setWorkspaceFilePath: vi.fn(),
        workspaceDrafts: {},
        workspaceFilePath: "printer.cfg",
        getWorkspaceContext: () => currentContext,
      }),
      {
        initialProps: { activeFiles: [file("printer.cfg", "A config")], printerId: "printer-A" },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current).not.toBeNull());

    let importPromise!: Promise<void>;
    act(() => {
      importPromise = result.current.importWorkspaceFiles([delayedFile]);
    });
    currentContext = { generation: 4, ownerPrinterId: "printer-B", selectedPrinterId: "printer-B" };
    rerender({ activeFiles: [file("printer.cfg", "B config"), file("B-only.cfg", "B data")], printerId: "printer-B" });
    await act(async () => {
      finishRead("imported from A");
      await importPromise;
    });

    expect(setWorkspaceDraftFiles).not.toHaveBeenCalled();
    expect(pendingConfigImport).toHaveBeenLastCalledWith(null);
    expect(setBuildStatus).toHaveBeenLastCalledWith(
      "Import cancelled because the printer or workspace changed; choose the files again",
    );
  });

  it("cancels replacement confirmation after the workspace changes", async () => {
    let currentContext = {
      generation: 2,
      ownerPrinterId: "printer-A",
      selectedPrinterId: "printer-A",
    };
    const setBuildStatus = vi.fn();
    const setWorkspaceDraftFiles = vi.fn();
    const pendingConfigImport = {
      conflicts: ["printer.cfg"],
      files: [file("printer.cfg", "replacement")],
      workspaceContext: { ...currentContext },
    };
    const wrapper = ({ children }: React.PropsWithChildren) => (
      <TestUiProvider><AccountStorageProvider userId={null}>{children}</AccountStorageProvider></TestUiProvider>
    );
    const { result } = renderHook(() => useWorkspaceActions({
      currentWorkspaceFile: file("printer.cfg", "B config"),
      pendingConfigImport,
      pendingWorkspaceFiles: [file("printer.cfg", "B config"), file("B-only.cfg", "B data")],
      selectedPrinter: { id: "printer-B", name: "printer-B" },
      setBuildStatus,
      setPackageDraft: () => {},
      setPendingConfigImport: vi.fn(),
      setWorkspaceContent: vi.fn(),
      setWorkspaceDrafts: vi.fn(),
      setWorkspaceDraftFiles,
      setWorkspaceFilePath: vi.fn(),
      workspaceDrafts: {},
      workspaceFilePath: "printer.cfg",
      getWorkspaceContext: () => currentContext,
    }), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    currentContext = { generation: 5, ownerPrinterId: "printer-B", selectedPrinterId: "printer-B" };
    act(() => result.current.confirmConfigImportReplacement());

    expect(setWorkspaceDraftFiles).not.toHaveBeenCalled();
    expect(setBuildStatus).toHaveBeenLastCalledWith(
      "Import cancelled because the printer or workspace changed; choose the files again",
    );
  });
});
