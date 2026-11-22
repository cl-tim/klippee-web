import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import {
  fetchState,
  getAccountStored,
  jsonResponse,
  setAccountStored,
  stubApiRoutes,
  workspaceTestPrinter,
} from "./test/appTestUtils";

describe("App printers", () => {
  it("renders printer lists alphabetically by printer name", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const cloudPrinters = [
      { id: "zeta", name: "Zeta", description: "", packageIds: [] },
      { id: "printer-10", name: "Printer 10", description: "", packageIds: [] },
      { id: "alpha", name: "alpha", description: "", packageIds: [] },
      { id: "printer-2", name: "Printer 2", description: "", packageIds: [] },
    ].map((printer) => ({
      ...printer,
      appliedVersionId: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      latestVersionId: 0,
      make: "",
      model: "",
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-01T00:00:00.000Z",
      variableValues: {},
    }));

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: cloudPrinters });
        if (url.includes("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Printers" }));

    await waitFor(() => {
      expect(Array.from(document.querySelectorAll(".printer-fleet-select strong")).map((node) => node.textContent)).toEqual([
        "alpha",
        "Printer 2",
        "Printer 10",
        "Zeta",
      ]);
    });
  });

  it("links an existing printer and generates a first-import command", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = {
      appliedVersionId: 0,
      createdAt: "2026-07-20T00:00:00.000Z",
      description: "",
      id: "printer-existing",
      latestVersionId: 0,
      make: "QIDI",
      model: "Plus 4",
      name: "Workshop QIDI",
      packageIds: [],
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-20T00:00:00.000Z",
      variableValues: {},
    };
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let importedVersions: unknown[] = [];
    let syncTokens: Array<{
      created_at: string;
      id: string;
      last_used_at: null;
      name: string;
      printer_id: string;
      scopes: string[];
      token_prefix: string;
    }> = [];

    stubApiRoutes((url, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        requests.push({ body, method, url });
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers") && method === "GET") return jsonResponse({ printers: [printer] });
        if (url.endsWith("/api/printers") && method === "POST") return jsonResponse({ printer });
        if (url.endsWith("/api/repos") && method === "POST") {
          return jsonResponse({ repository: { id: "repo-linked", name: "workshop-qidi-printer-e" }, version: null });
        }
        if (url.endsWith("/api/repos") && method === "GET") return jsonResponse({ repositories: [] });
        if (url.endsWith("/api/repos/repo-linked/sync-tokens") && method === "POST") {
          const tokenRecord = {
            created_at: "2026-07-22T00:00:00.000Z",
            id: "token-import",
            last_used_at: null,
            name: "Workshop QIDI printer sync token",
            printer_id: "printer-existing",
            scopes: ["repo:read", "repo:write"],
            token_prefix: "klp_import_o",
          };
          syncTokens = [tokenRecord];
          return jsonResponse({ token: "klp_import_once", tokenRecord });
        }
        if (url.endsWith("/api/repos/repo-linked/sync-tokens")) return jsonResponse({ tokens: syncTokens });
        if (url.endsWith("/api/repos/repo-linked/sync-tokens/token-import") && method === "DELETE") {
          syncTokens = [];
          return jsonResponse({ ok: true });
        }
        if (url.endsWith("/api/repos/repo-linked/sync-status")) {
          return jsonResponse({
            latestVersion: null,
            printer: {
              ...printer,
              hostInfo: {
                klipperVersion: "v0.13.0-296-g12345678",
                moonrakerVersion: "v0.9.3-64",
                os: "Debian GNU/Linux 12 (bookworm)",
              },
              hostInfoUpdatedAt: "2026-07-22T01:00:00.000Z",
              repositoryId: "repo-linked",
            },
          });
        }
        if (url.split("?")[0].endsWith("/api/repos/repo-linked/versions")) {
          return jsonResponse({
            versions: importedVersions,
          });
        }
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        return jsonResponse({ ok: true });
      });

    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Printers" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Workshop QIDI/ }));
    expect(await screen.findByRole("heading", { name: "Workshop QIDI" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect the physical printer" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Connect printer" }));

    expect(await screen.findByRole("heading", {
      name: "Connect hlab and capture the current configuration",
    })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linux ARM64" })).toHaveAttribute("href", "https://github.com/cl-tim/hlab/releases/download/v0.3.0/hlab-linux-arm64");
    expect(screen.getByText(/hlab klippee init --printer --capture-current/)).toBeInTheDocument();
    expect(requests).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ empty: true, title: "Workshop QIDI" }),
      method: "POST",
      url: "/api/repos",
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ printerId: "printer-existing" }),
      method: "POST",
      url: "/api/repos/repo-linked/sync-tokens",
    }));

    await userEvent.type(screen.getByLabelText(/Configuration folder/), "/home/mks/klipper_config");
    expect(screen.getByText(/KLIPPEE_CONFIG_DIR='\/home\/mks\/klipper_config'/)).toBeInTheDocument();

    // Once the printer imports its config, the panel flips to the sync-state
    // view and offers a reinstall command without the first-import flag.
    importedVersions = [{
      created_at: "2026-07-22T00:00:00.000Z",
      files: [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "main" }],
      message: "Initial import from printer",
      source: "capture",
      version_number: 1,
    }];
    await userEvent.click(screen.getByRole("button", { name: /Check capture/ }));

    expect(await screen.findByRole("tab", { name: "Overview" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Host software details"));
    expect(screen.getByText("Debian GNU/Linux 12 (bookworm)")).toBeInTheDocument();
    expect(screen.getByText("v0.13.0-296-g12345678")).toBeInTheDocument();
    expect(screen.getByText("v0.9.3-64")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "CLI" }));
    const cliPanel = within(screen.getByRole("tabpanel", { name: "CLI" }));
    expect(screen.queryByRole("heading", { name: "Manage configuration from the printer host" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect hlab" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Check what will change" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose which configuration wins" })).toBeInTheDocument();
    expect(cliPanel.getByText("hlab klippee target")).toBeInTheDocument();
    expect(cliPanel.getByText("hlab klippee check --diff")).toBeInTheDocument();
    expect(cliPanel.getByText("hlab klippee capture")).toBeInTheDocument();
    expect(cliPanel.getByText("hlab klippee apply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Access" })).not.toBeInTheDocument();
    const reinstallCommand = screen.getByText(/KLIPPEE_TOKEN='klp_import_once'/);
    expect(reinstallCommand.textContent).toContain("KLIPPEE_CONFIG_DIR='/home/mks/klipper_config'");
    expect(reinstallCommand.textContent).toContain("hlab klippee init --printer");
    expect(reinstallCommand.textContent).not.toContain("--capture-current");

    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(screen.getByRole("heading", { name: "Create your configuration folder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect hlab and download the configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edit and sync your configuration" })).toBeInTheDocument();
    expect(document.querySelectorAll(".desktop-sync-workflow > .cli-command-card")).toHaveLength(3);
    const platformPicker = screen.getByRole("radiogroup", { name: "Desktop operating system" });
    expect(within(platformPicker).getByRole("radio", { name: "Windows" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Windows x64" })).toHaveAttribute("href", "https://github.com/cl-tim/hlab/releases/download/v0.3.0/hlab-windows-amd64.exe");
    await userEvent.click(within(platformPicker).getByRole("radio", { name: "macOS / Linux" }));
    expect(within(platformPicker).getByRole("radio", { name: "macOS / Linux" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Generate setup command" }));
    expect(await screen.findByText(/hlab klippee init --desktop --apply-current/)).toBeInTheDocument();
    expect(screen.getByText("macOS / Linux setup")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "macOS Apple silicon" })).toHaveAttribute("href", "https://github.com/cl-tim/hlab/releases/download/v0.3.0/hlab-darwin-arm64");
    expect(screen.getByText('hlab klippee capture --note "Edited on desktop"')).toBeInTheDocument();
    const unixSetup = screen.getByText(/hlab klippee init --desktop --apply-current/).textContent ?? "";
    expect(unixSetup).not.toContain("python");
    expect(unixSetup).not.toContain("/install/klippee.py");
    await userEvent.click(within(platformPicker).getByRole("radio", { name: "Windows" }));
    const windowsSetup = screen.getByText(/hlab klippee init --desktop --apply-current/).textContent ?? "";
    expect(windowsSetup).toContain("Remove-Item Env:KLIPPEE_TOKEN");
    expect(windowsSetup).not.toContain("Invoke-WebRequest");

    await userEvent.click(screen.getByRole("tab", { name: "CLI" }));
    await userEvent.click(screen.getByText("Manage CLI access"));
    await userEvent.click(await screen.findByRole("button", {
      name: "Revoke Workshop QIDI printer sync token",
    }));
    const revokeConfirmation = screen.getByRole("group", {
      name: "Confirm revoke Workshop QIDI printer sync token",
    });
    expect(within(revokeConfirmation).getByText(/stop syncing immediately/)).toBeInTheDocument();
    await userEvent.click(within(revokeConfirmation).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => {
      expect(screen.queryByText(/KLIPPEE_TOKEN='klp_import_once'/)).not.toBeInTheDocument();
    });
    expect(screen.getByText("Generate a private command when you are ready to connect hlab.")).toBeInTheDocument();
  }, 10000);

  it("does not undo a printer switch when an older cloud printer load finishes", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const fileA = {
      content: "[printer]\nmax_velocity: 200\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const fileB = { ...fileA, content: "[printer]\nmax_velocity: 400\n" };
    const historyA = [{
      createdAt: "2026-08-05T00:00:00.000Z",
      files: [fileA],
      id: 1,
      message: "Printer A",
      previousId: null,
      source: "capture",
    }];
    const historyB = [{
      ...historyA[0],
      files: [fileB],
      message: "Printer B",
    }];
    const printerA = {
      ...workspaceTestPrinter("printer-load-race-a"),
      history: historyA,
      latestVersionId: 1,
      name: "Race Printer A",
      variableValues: { beacon_serial: "serial-a" },
      workspaceFilePath: "printer.cfg",
    };
    const printerB = {
      ...workspaceTestPrinter("printer-load-race-b"),
      history: historyB,
      latestVersionId: 1,
      name: "Race Printer B",
      variableValues: { beacon_serial: "serial-b" },
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", historyA);
    setAccountStored("printers", [printerA, printerB]);
    setAccountStored("selectedPrinterId", printerA.id);
    setAccountStored("values", printerA.variableValues);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", fileA.content);
    Object.defineProperty(Object.getPrototypeOf(document.createRange()) as object, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(0, 0, 10, 10)],
    });

    let resolvePrinterLoad: ((response: Response) => void) | null = null;
    let printerLoadCount = 0;
    stubApiRoutes((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers") && method === "GET") {
        printerLoadCount += 1;
        if (printerLoadCount === 1) {
          // Complete bootstrap while retaining the local fleet. Entering the
          // Printers tab then exercises the product's documented retry path.
          return jsonResponse({}, 503);
        }
        return new Promise<Response>((resolve) => {
          resolvePrinterLoad = resolve;
        });
      }
      if (url.endsWith("/api/printers") && method === "POST") {
        return jsonResponse({ printer: JSON.parse(String(init?.body)).printer });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    window.history.pushState({}, "", "/");
    render(<App />);

    await screen.findByRole("textbox", { name: "Edit printer.cfg" });
    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    const selectPrinterB = await screen.findByRole("button", { name: /^Race Printer B/ });
    await waitFor(() => expect(printerLoadCount).toBe(2));
    await userEvent.click(selectPrinterB);
    expect(await screen.findByRole("heading", { name: "Race Printer B" })).toBeInTheDocument();
    expect(getAccountStored("selectedPrinterId", "")).toBe(printerB.id);

    await act(async () => {
      // This response was requested while A was selected and intentionally
      // omits B, making any stale reconciliation immediately observable.
      resolvePrinterLoad?.(jsonResponse({ printers: [printerA] }));
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(screen.getByRole("heading", { name: "Race Printer B" })).toBeInTheDocument();
    expect(getAccountStored("selectedPrinterId", "")).toBe(printerB.id);
    expect(getAccountStored<Array<typeof printerA | typeof printerB>>("printers", []).map((record) => record.id))
      .toEqual([printerA.id, printerB.id]);
    expect(getAccountStored("values", {})).toEqual({ beacon_serial: "serial-b" });
  });

  it("keeps a renamed printer workspace when another printer is added and deleted", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const savedHistory = [
      {
        createdAt: "2026-07-01T00:00:00.000Z",
        files: [{ content: "[printer]\nmax_velocity: 300\n", path: "printer.cfg", public: false, role: "printer" }],
        id: 1,
        message: "Saved config",
        previousId: null,
        source: "manual",
      },
    ];
    const localPrinter = {
      appliedVersionId: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      description: "",
      history: [],
      id: "printer-original",
      latestVersionId: 1,
      make: "",
      model: "",
      name: "Renamed printer",
      packageIds: [],
      repositoryId: null,
      source: "manual",
      updatedAt: "2026-07-02T00:00:00.000Z",
      variableValues: {},
      workspaceFilePath: "printer.cfg",
    };
    const cloudPrinter: Partial<typeof localPrinter> = { ...localPrinter };
    delete cloudPrinter.history;
    delete cloudPrinter.workspaceFilePath;
    setAccountStored("printers", [localPrinter]);
    setAccountStored("selectedPrinterId", localPrinter.id);
    setAccountStored("history", savedHistory);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", "[printer]\nmax_velocity: 350\n");
    setAccountStored("workspaceDrafts", { "printer.cfg": "[printer]\nmax_velocity: 350\n" });
    const printerCloudOperations: string[] = [];
    let resolveNewPrinterSave: ((response: Response) => void) | null = null;

    stubApiRoutes((url, init) => {
        const method = init?.method ?? "GET";
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers") && method === "GET") {
          return jsonResponse({ printers: [cloudPrinter] });
        }
        if (url.endsWith("/api/printers") && method === "POST") {
          printerCloudOperations.push("POST");
          return new Promise<Response>((resolve) => {
            resolveNewPrinterSave = resolve;
          });
        }
        if (url.includes("/api/printers/") && method === "DELETE") {
          printerCloudOperations.push("DELETE");
          return jsonResponse({ ok: true });
        }
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({ ok: true });
      });

    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Printers" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add printer" }));
    await userEvent.click(await screen.findByRole("button", { name: /Custom printer/i }));
    await userEvent.type(await screen.findByLabelText(/Printer name/), "Printer 2");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add printer" }));

    let storedPrinters = getAccountStored<Array<{
      history?: typeof savedHistory;
      id: string;
      workspaceDrafts?: Record<string, string>;
    }>>("printers", []);
    const storedOriginal = storedPrinters.find((printer) => printer.id === localPrinter.id);
    expect(storedOriginal?.history).toEqual(savedHistory);
    expect(storedOriginal?.workspaceDrafts?.["printer.cfg"]).toContain("350");

    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Printer 2/ }));
    await userEvent.click(
      (await screen.findAllByText("Printer details")).find((element) => element.tagName === "SPAN")!,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete Printer 2" }));
    const confirmDelete = screen.getByRole("button", { name: "Delete printer" });
    expect(confirmDelete).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type Printer 2 to confirm deletion"), "Printer 2");
    await userEvent.click(confirmDelete);

    expect(printerCloudOperations).toEqual(["POST"]);
    expect(resolveNewPrinterSave).not.toBeNull();
    act(() => {
      resolveNewPrinterSave?.(jsonResponse({ printer: null }));
    });
    await waitFor(() => {
      expect(printerCloudOperations).toEqual(["POST", "DELETE"]);
    });

    storedPrinters = getAccountStored("printers", []);
    expect(storedPrinters.map((printer) => printer.id)).toEqual([localPrinter.id]);
    expect(getAccountStored("history", [])).toEqual(savedHistory);
    expect(getAccountStored<Record<string, string>>("workspaceDrafts", {})["printer.cfg"]).toContain("350");
  }, 15000);

  it("cancels queued printer writes when the app unmounts", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = {
      ...workspaceTestPrinter("printer-unmount-queue"),
      name: "Unmount queue printer",
    };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    const cloudOperations: string[] = [];
    let resolveMetadataSave: ((response: Response) => void) | null = null;

    stubApiRoutes((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers") && method === "GET") return jsonResponse({ printers: [printer] });
      if (url.endsWith("/api/printers") && method === "POST") {
        cloudOperations.push("POST");
        return new Promise<Response>((resolve) => {
          resolveMetadataSave = resolve;
        });
      }
      if (url.includes("/api/printers/") && method === "DELETE") {
        cloudOperations.push("DELETE");
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({ ok: true });
    });

    const rendered = render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Printers" }));
    await userEvent.click(
      (await screen.findAllByText("Printer details")).find((element) => element.tagName === "SPAN")!,
    );
    const nameInput = screen.getByDisplayValue(printer.name);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Queued rename");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(cloudOperations).toEqual(["POST"]));

    // The rename is still awaiting the cloud; deletion uses the confirmed name.
    await userEvent.click(await screen.findByRole("button", { name: `Delete ${printer.name}` }));
    await userEvent.type(screen.getByLabelText(`Type ${printer.name} to confirm deletion`), printer.name);
    await userEvent.click(screen.getByRole("button", { name: "Delete printer" }));
    expect(cloudOperations).toEqual(["POST"]);

    rendered.unmount();
    await act(async () => {
      resolveMetadataSave?.(jsonResponse({ printer: null }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cloudOperations).toEqual(["POST"]);
  });
});
