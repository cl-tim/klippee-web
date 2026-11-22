import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  fetchState,
  getAccountStored,
  jsonResponse,
  setAccountStored,
  stubApiRoutes,
  stubWorkspacePrinterApi,
  workspaceTestPrinter,
} from "./test/appTestUtils";

describe("App workspace editor", () => {
  it("keeps recovery and install available without a persistent workspace dock", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await screen.findByText("Configuration Files");
    expect(screen.getByRole("button", { name: "Publish to Shared Configs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Recovery/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Install/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace tools")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Configure printer values" })).not.toBeInTheDocument();
  });

  it("keeps workspace files available and opens them as a compact-screen drawer", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({
      matches: query === "(max-width: 980px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) });

    try {
      render(<App />);

      const openButton = await screen.findByRole("button", { name: "Files & printer" });
      expect(openButton).toHaveAttribute("aria-expanded", "false");
      expect(openButton).toHaveAttribute("aria-controls", "slicer-workspace-navigation");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      await userEvent.click(openButton);
      const drawer = await screen.findByRole("dialog");
      const navigation = document.getElementById("slicer-workspace-navigation");
      expect(openButton).toHaveAttribute("aria-expanded", "true");
      expect(navigation).toBeInTheDocument();
      expect(drawer).toContainElement(navigation);

      await userEvent.click(within(drawer).getByRole("button", { name: "Close files and printer" }));
      await waitFor(() => {
        expect(openButton).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });

  it("auto-saves edits with no manual save action below the editor", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await screen.findByText("Configuration Files");
    const syncBar = document.querySelector(".workspace-sync-bar");

    // Edits auto-save; there is no manual sync/save button and no change note.
    expect(syncBar).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sync to printer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save configuration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Configuration change note" })).not.toBeInTheDocument();
    // The autosave status and its guidance are shown in the bottom bar.
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(syncBar?.querySelector(".workspace-sync-hint")).not.toBeNull();
  });

  it("routes workspace Install directly to the printer page", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await screen.findByText("Configuration Files");
    await userEvent.click(screen.getByRole("button", { name: /^Install/ }));

    expect(await screen.findByRole("heading", { name: "Printers" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/printers");
    expect(window.location.search).toBe("?section=cli");
    expect(screen.queryByRole("dialog", { name: /Install configs/ })).not.toBeInTheDocument();
  });

  it("guides workspace variables from editor selection instead of a bulk candidate list", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const devicePath = "/dev/serial/by-id/usb-Beacon_Beacon_RevH_123456-if00";
    const untouchedPath = "/dev/serial/by-id/usb-Klipper_secondary_mcu-if00";
    const workspaceFile = {
      content: `[mcu]\nserial: \${KLIPPEE:mcu_serial}\n\n[mcu secondary]\nserial: ${untouchedPath}\n`,
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const history = [{
      createdAt: "2026-07-22T00:00:00.000Z",
      files: [workspaceFile],
      id: 1,
      message: "Imported config",
      previousId: null,
      source: "capture",
    }];
    const printer = {
      appliedVersionId: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      description: "",
      history,
      id: "printer-variable-guide",
      latestVersionId: 1,
      make: "",
      model: "",
      name: "Workshop printer",
      packageIds: [],
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-22T00:00:00.000Z",
      variableValues: { mcu_serial: devicePath },
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", workspaceFile.content);
    setAccountStored("workspaceDrafts", { "printer.cfg": workspaceFile.content });
    setAccountStored("values", { mcu_serial: devicePath });

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({ ok: true });
      });

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Edit printer.cfg" })).toBeInTheDocument();
    expect(document.querySelector(".slicer-right")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace tools")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make selected value a variable" })).not.toBeInTheDocument();
    expect(document.querySelector(".cm-content")).toHaveTextContent("${KLIPPEE:mcu_serial}");
    expect(screen.queryByDisplayValue(devicePath)).not.toBeInTheDocument();
    expect(getAccountStored("history", [])).toHaveLength(1);
  });

  it("uses one explicit per-key variable mutation and keeps host-local values under StrictMode", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const placeholder = "${KLIPPEE:beacon_serial}";
    const initialValue = "/dev/serial/by-id/usb-Beacon_initial-if00";
    const updatedValue = "/dev/serial/by-id/usb-Beacon_updated-if00";
    const workspaceFile = {
      content: `[beacon]\nserial: ${placeholder}\n`,
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const history = [{
      createdAt: "2026-08-06T00:00:00.000Z",
      files: [workspaceFile],
      id: 1,
      message: "Variable workspace",
      previousId: null,
      source: "capture",
    }];
    const printer = {
      ...workspaceTestPrinter("printer-variable-payload"),
      history,
      latestVersionId: 1,
      name: "Variable payload printer",
      variableValues: { beacon_serial: initialValue },
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("values", printer.variableValues);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", workspaceFile.content);

    const printerMutations: Array<{
      body: Record<string, unknown>;
      method: string;
      url: string;
    }> = [];
    stubApiRoutes((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers") && method === "GET") return jsonResponse({ printers: [printer] });
      if (url.endsWith("/api/printers") && method === "POST") {
        printerMutations.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          method,
          url,
        });
        return jsonResponse({ printer });
      }
      if (url.endsWith(`/api/printers/${printer.id}/variables/beacon_serial`) && method === "PATCH") {
        printerMutations.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          method,
          url,
        });
        return jsonResponse({
          printer: {
            ...printer,
            name: "Renamed variable printer",
            variableValues: { beacon_serial: initialValue },
          },
          stored: false,
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({ ok: true });
    });

    render(<StrictMode><App /></StrictMode>);

    await screen.findByRole("textbox", { name: "Edit printer.cfg" }, { timeout: 4000 });
    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    await userEvent.click(
      (await screen.findAllByText("Printer details")).find((element) => element.tagName === "SPAN")!,
    );
    const nameInput = screen.getByDisplayValue(printer.name);
    fireEvent.change(nameInput, { target: { value: "Renamed variable printer" } });
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(printerMutations).toHaveLength(1));
    expect(printerMutations[0]).toMatchObject({ method: "POST" });
    expect(printerMutations[0].body.printer).not.toHaveProperty("variableValues");

    await userEvent.click(screen.getByRole("link", { name: "Klipper Workspace" }));
    const editor = await screen.findByRole("textbox", { name: "Edit printer.cfg" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    Object.defineProperty(Object.getPrototypeOf(document.createRange()) as object, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(0, 0, 10, 10)],
    });
    const placeholderStart = editorView!.state.doc.toString().indexOf(placeholder);
    expect(placeholderStart).toBeGreaterThanOrEqual(0);
    act(() => {
      editorView!.dispatch({
        selection: { anchor: placeholderStart, head: placeholderStart + placeholder.length },
      });
    });

    await userEvent.click(await screen.findByRole("button", { name: "Set value for variable beacon_serial" }));
    const valueInput = await screen.findByLabelText<HTMLInputElement>(/Value for .*beacon serial/i);
    const valueForm = valueInput.closest("form");
    expect(valueForm).not.toBeNull();
    act(() => {
      valueInput.value = updatedValue;
      valueForm!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(printerMutations).toHaveLength(2));
    expect(printerMutations[1]).toMatchObject({
      body: { value: updatedValue },
      method: "PATCH",
      url: expect.stringContaining(`/api/printers/${printer.id}/variables/beacon_serial`),
    });
    expect(printerMutations.filter((mutation) => mutation.method === "POST")).toHaveLength(1);
    await waitFor(() => {
      expect(getAccountStored("values", {})).toEqual({ beacon_serial: updatedValue });
      const [storedPrinter] = getAccountStored<Array<typeof printer>>("printers", []);
      expect(storedPrinter.variableValues).toEqual({ beacon_serial: updatedValue });
    });
  });

  it("shows recovery commands for saved points, including cancelling a pending draft", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const files = [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }];
    const history = [
      { createdAt: "2026-07-22T00:00:00.000Z", files, id: 1, message: "Initial", previousId: null, source: "capture" },
      { createdAt: "2026-07-22T00:01:00.000Z", files, id: 2, message: "Reviewed", previousId: 1, source: "web-editor" },
    ];
    const draftContent = `${files[0].content}# unsaved note\n`;
    const printer = {
      appliedVersionId: 2,
      createdAt: "2026-07-22T00:00:00.000Z",
      description: "",
      history,
      id: "printer-recovery",
      latestVersionId: 2,
      make: "",
      model: "",
      name: "Recovery printer",
      packageIds: [],
      repositoryId: "repo-recovery",
      source: "manual",
      updatedAt: "2026-07-22T00:01:00.000Z",
      workspaceDrafts: { "printer.cfg": draftContent },
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", draftContent);
    setAccountStored("workspaceDrafts", printer.workspaceDrafts);

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
        if (url.split("?")[0].endsWith("/api/repos/repo-recovery/versions")) {
          return jsonResponse({
            versions: history.map((version) => ({
              created_at: version.createdAt,
              files: version.files,
              id: `version-${version.id}`,
              message: version.message,
              previous_version_id: version.previousId ? `version-${version.previousId}` : null,
              source: version.source,
              version_number: version.id,
            })),
          });
        }
        if (url.endsWith("/api/repos/repo-recovery/sync-status")) {
          return jsonResponse({
            appliedVersion: { version_number: 2 },
            latestVersion: { version_number: 2 },
            pendingConfiguration: {
              fileCount: 1,
              revision: "sha256:pending-draft",
              updatedAt: "2026-07-22T00:02:00.000Z",
            },
            printer,
            targetVersionNumber: 3,
            targetRevision: "sha256:pending-draft",
            updateAvailable: true,
          });
        }
        if (url.endsWith("/api/repos/repo-recovery/sync-tokens")) return jsonResponse({ tokens: [] });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({ ok: true });
      });

    render(<App />);
    await userEvent.click(await screen.findByText("Recovery"));
    expect(await screen.findByText("A draft is currently desired")).toBeInTheDocument();
    expect(screen.getByText("Latest saved")).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Recovery point 1/ }));

    expect(await screen.findByText("Changes in recovery point 1")).toBeInTheDocument();
    expect(screen.getByText("hlab klippee recover cloud:1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Recovery point 2/ }));
    expect(await screen.findByText("Changes in recovery point 2")).toBeInTheDocument();
    expect(screen.getByText("hlab klippee recover cloud:2")).toBeInTheDocument();
    expect(screen.getAllByText("printer.cfg").length).toBeGreaterThan(1);
    expect(getAccountStored<Array<{ id: number }>>("history", []).map((version) => version.id)).toEqual([1, 2]);
    expect(getAccountStored("workspaceDrafts", {})).toEqual({ "printer.cfg": draftContent });
  });

  it("protects the last-applied recovery point and deletes another local history entry", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const firstFiles = [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }];
    const history = [
      { createdAt: "2026-07-22T00:00:00.000Z", files: firstFiles, id: 1, message: "Initial", previousId: null, source: "capture" },
      { createdAt: "2026-07-22T00:01:00.000Z", files: firstFiles, id: 2, message: "Duplicate", previousId: 1, source: "capture" },
      { createdAt: "2026-07-22T00:02:00.000Z", files: [{ ...firstFiles[0], content: `${firstFiles[0].content}# changed\n` }], id: 3, message: "Changed", previousId: 2, source: "web-editor" },
    ];
    const printer = {
      appliedVersionId: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      description: "",
      history,
      id: "printer-history-delete",
      latestVersionId: 3,
      make: "",
      model: "",
      name: "History printer",
      packageIds: [],
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-22T00:02:00.000Z",
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", history[2].files[0].content);

    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.click(await screen.findByText("Recovery"));
    expect(await screen.findByText("Duplicate of 1")).toBeInTheDocument();
    const appliedDeleteButton = screen.getByRole("button", { name: "Delete recovery point 1" });
    expect(appliedDeleteButton).toBeDisabled();
    expect(appliedDeleteButton).toHaveAttribute("title", "The last confirmed printer configuration cannot be deleted");
    await userEvent.click(screen.getByRole("button", { name: "Delete recovery point 2" }));
    expect(screen.getByText("Delete recovery point 2?")).toBeInTheDocument();
    expect(screen.getByText("This permanently removes this saved recovery option.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep recovery point" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete recovery point 2" }));

    await waitFor(() => {
      expect(getAccountStored<Array<{ id: number }>>("history", []).map((version) => version.id)).toEqual([1, 3]);
    });
    const storedPrinter = getAccountStored<Array<{ appliedVersionId: number; latestVersionId: number }>>("printers", [])[0];
    expect(storedPrinter.appliedVersionId).toBe(1);
    expect(storedPrinter.latestVersionId).toBe(3);
  });

  it("shows the correct buffer when returning to a previously opened config file", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const files = [
      {
        content: "# printer file marker\n[printer]\nkinematics: corexy\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      },
      {
        content: "# hardware file marker\n[stepper_x]\nstep_pin: PA1\n",
        path: "hardware.cfg",
        public: false,
        role: "include",
      },
    ];
    const history = [{
      createdAt: "2026-07-22T00:00:00.000Z",
      files,
      id: 1,
      message: "Imported config",
      previousId: null,
      source: "capture",
    }];
    const printer = {
      appliedVersionId: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      description: "",
      history,
      id: "printer-file-switch",
      latestVersionId: 1,
      make: "",
      model: "",
      name: "File switch printer",
      packageIds: [],
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-22T00:00:00.000Z",
      variableValues: {},
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", files[0].content);

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({ ok: true });
      });

    render(<App />);

    await screen.findByRole("heading", { level: 2, name: "printer.cfg" });
    const editorContent = () => document.querySelector(".cm-content");
    await waitFor(() => expect(editorContent()).toHaveTextContent("printer file marker"));

    await userEvent.click(screen.getByRole("button", { name: /^hardware\.cfg/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "hardware.cfg" })).toBeInTheDocument();
    await waitFor(() => expect(editorContent()).toHaveTextContent("hardware file marker"));
    expect(editorContent()).not.toHaveTextContent("printer file marker");

    await userEvent.click(screen.getByRole("button", { name: /^printer\.cfg/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "printer.cfg" })).toBeInTheDocument();
    await waitFor(() => expect(editorContent()).toHaveTextContent("printer file marker"));
    expect(editorContent()).not.toHaveTextContent("hardware file marker");
    expect(getAccountStored("workspaceDrafts", {})).toEqual({});
  });

  it("requires the exact config path before deleting a workspace file", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await screen.findByText("Configuration Files");

    fireEvent.change(screen.getByLabelText("New config file path"), { target: { value: "keep_me.cfg" } });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("button", { name: "Delete keep_me.cfg" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New config file path"), { target: { value: "delete_me.cfg" } });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("button", { name: "Delete delete_me.cfg" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete delete_me.cfg" }));

    const deletePanel = screen.getByRole("group", { name: "Confirm deletion of delete_me.cfg" });
    const confirmInput = screen.getByLabelText("Type delete_me.cfg to confirm deletion");
    const confirmButton = screen.getByRole("button", { name: "Delete file" });

    expect(deletePanel).toHaveTextContent("explicitly apply this draft, at which point it will lose the file");
    expect(confirmButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "wrong.cfg" } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "delete_me.cfg" } });
    expect(confirmButton).toBeEnabled();

    await userEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Delete delete_me.cfg" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("group", { name: "Confirm deletion of delete_me.cfg" })).not.toBeInTheDocument();
  });

  it("rejects sensitive runtime files during workspace folder import", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await screen.findByText("Configuration Files");

    const uploadInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!uploadInput) throw new Error("Workspace file upload input was not rendered");
    expect(screen.getByRole("button", { name: "Upload CFG" })).toBeInTheDocument();
    await userEvent.upload(uploadInput, [
      new File(["[beacon]\nserial: /dev/serial/by-id/usb-Beacon_Beacon_RevH_123456-if00\n"], "beacon.cfg", {
        type: "text/plain",
      }),
      new File(["token: should-not-enter-workspace\n"], "saved_variables.cfg", { type: "text/plain" }),
    ]);

    expect(await screen.findByRole("button", { name: "Delete beacon.cfg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete saved_variables.cfg" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Publish to Shared Configs" }));
    expect(screen.getByText(/skipped 1 non-config or sensitive file/i)).toBeInTheDocument();
  });
});
