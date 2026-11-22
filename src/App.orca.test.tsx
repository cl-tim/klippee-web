import { render, screen, waitFor } from "@testing-library/react";
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

describe("App Orca workspace", () => {
  it("keeps the profile editor independent of physical printer selection", async () => {
    const consoleError = vi.spyOn(console, "error");
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "orca-printer-switch", providers: [] };
    const printerA = { ...workspaceTestPrinter("orca-printer-a"), name: "Printer A" };
    const printerB = { ...workspaceTestPrinter("orca-printer-b"), name: "Printer B" };
    setAccountStored("printers", [printerA, printerB]);
    setAccountStored("selectedPrinterId", printerA.id);
    const assetA = {
      id: "preset-a",
      kind: "filament",
      printerId: printerA.id,
      title: "A filament",
      description: "",
      content: JSON.stringify({ type: "filament", name: "A filament", filament_settings_id: ["a"] }),
      tags: [],
      public: false,
      version: "1",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    setAccountStored("companionAssets", [assetA]);
    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printerA, printerB] });
      if (url.endsWith("/api/companion-assets") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { asset: typeof assetA };
        return jsonResponse({ asset: body.asset });
      }
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [assetA] });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));
    await userEvent.click(await screen.findByRole("button", { name: /A filament/ }));
    await userEvent.clear(screen.getByLabelText("Preset name"));
    await userEvent.type(screen.getByLabelText("Preset name"), "A unsaved edit");

    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Printer B/ }));
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));

    expect(await screen.findByRole("heading", { name: "Orca Workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("Preset name")).toHaveValue("A unsaved edit");
    expect(screen.getByRole("button", { name: "Update preset" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New filament" }));
    await userEvent.type(screen.getByLabelText("Preset name"), "B filament");
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(getAccountStored<Array<{ title: string; printerId: string }>>("companionAssets", []).some(
      (asset) => asset.title === "B filament" && asset.printerId == null,
    )).toBe(true));

    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Printer A/ }));
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));
    expect(await screen.findByRole("heading", { name: "Orca Workspace" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /A filament/ }));
    await userEvent.clear(screen.getByLabelText("Preset name"));
    await userEvent.type(screen.getByLabelText("Preset name"), "A saved edit");
    await userEvent.click(screen.getByRole("button", { name: "Update preset" }));
    await waitFor(() => expect(getAccountStored<Array<{ id: string; title: string; printerId: string }>>("companionAssets", []).find(
      (asset) => asset.id === "preset-a",
    )).toMatchObject({ id: "preset-a", printerId: printerA.id, title: "A saved edit" }));
    expect(consoleError.mock.calls.some((args) => args.some((value) => (
      String(value).includes("Cannot update a component")
    )))).toBe(false);
  }, 10000);

  it("creates account-wide OrcaSlicer presets and links one to a package", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = { ...workspaceTestPrinter("orca-printer"), name: "Bench printer" };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    const privatePackage = {
      description: "Private package",
      files: [{ content: "[printer]\n", path: "printer.cfg", public: false, role: "printer" }],
      hardware: ["cartesian"],
      id: "private-package",
      name: "private-package",
      printer: "Bench printer",
      tags: ["private"],
      title: "Bench Klipper Package",
      variables: [],
      version: "1",
      warnings: [],
    };
    setAccountStored("privatePackages", [privatePackage]);
    setAccountStored("selectedPackageId", "private-package");
    stubWorkspacePrinterApi(printer, { privatePackages: [privatePackage] });

    render(<App />);

    // The Orca Workspace is per-printer: open it for the selected printer.
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));

    // Create a filament preset. The dynamic editor mounts (search box present)
    // even for a fresh, field-less preset.
    await userEvent.click(await screen.findByRole("button", { name: "New filament" }));
    await userEvent.type(screen.getByLabelText("Preset name"), "PLA fast profile");
    expect(screen.getByLabelText("Search preset settings")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(await screen.findByRole("button", { name: /PLA fast profile/ })).toBeInTheDocument();

    // Create a printer preset in the SAME workspace, then link it to the package.
    await userEvent.click(screen.getByRole("button", { name: "New printer" }));
    await userEvent.type(screen.getByLabelText("Preset name"), "Orca Bench printer");
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(await screen.findByRole("button", { name: /Orca Bench printer/ })).toBeInTheDocument();

    // Both presets live in the one workspace, grouped by type.
    expect(screen.getByRole("button", { name: /PLA fast profile/ })).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Link to package" }));
    expect(await screen.findByRole("button", { name: "Publish preset" })).toBeInTheDocument();
    expect(screen.getByText("Linked to Bench Klipper Package")).toBeInTheDocument();

    const storedPackages = getAccountStored<Array<{ companionAssetIds?: string[] }>>("privatePackages", []);
    expect(storedPackages[0].companionAssetIds).toHaveLength(1);
  }, 10000);

  it("opens the Orca library and editor without a physical printer", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      return jsonResponse({});
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));

    expect(await screen.findByRole("heading", { name: "Orca Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New filament" })).toBeInTheDocument();
  });

  it("requires inline confirmation before deleting a preset", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = { ...workspaceTestPrinter("orca-printer"), name: "Bench printer" };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    const asset = {
      id: "preset-1",
      kind: "filament",
      printerId: printer.id,
      title: "PLA fast profile",
      description: "",
      content: JSON.stringify({ type: "filament", name: "PLA fast profile", filament_settings_id: ["x"] }),
      tags: [],
      public: false,
      version: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    setAccountStored("companionAssets", [asset]);
    let deleted = false;
    const requests = stubApiRoutes((url, init) => {
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.endsWith("/api/companion-assets/preset-1") && init?.method === "DELETE") {
        deleted = true; return jsonResponse({ ok: true, deletedAssetId: asset.id });
      }
      if (url.endsWith("/api/companion-assets")) return jsonResponse({ assets: deleted ? [] : [asset] });
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));
    await userEvent.click(await screen.findByRole("button", { name: /PLA fast profile/ }));

    // First click only reveals an inline confirmation; nothing is deleted yet.
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("group", { name: "Confirm delete preset" })).toBeInTheDocument();
    expect(getAccountStored("companionAssets", [])).toHaveLength(1);

    expect(requests.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    // Cancel keeps the preset and restores the plain delete action.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm delete preset" })).not.toBeInTheDocument();
    expect(getAccountStored("companionAssets", [])).toHaveLength(1);

    // Confirming actually deletes.
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete preset" }));
    await waitFor(() => {
      expect(getAccountStored("companionAssets", [])).toHaveLength(0);
    });
    expect(requests.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  }, 10000);

  it("serves published preset share links at /assets/:slug without sign-in", async () => {
    stubApiRoutes((url) => {
      if (url.includes("/api/public-companion-assets/pla-fast-profile-filament-preset-1")) {
        return jsonResponse({
          asset: {
            id: "preset-1",
            kind: "filament",
            title: "PLA fast profile",
            description: "Shared bench filament preset.",
            content: JSON.stringify({ type: "filament", name: "PLA fast profile" }),
            tags: ["pla"],
            public: true,
            publicSlug: "pla-fast-profile-filament-preset-1",
            publishedAt: "2026-07-24T00:00:00.000Z",
            version: "1",
            createdAt: "2026-07-24T00:00:00.000Z",
            updatedAt: "2026-07-24T00:00:00.000Z",
          },
        });
      }
      return undefined;
    });
    window.history.pushState(null, "", "/assets/pla-fast-profile-filament-preset-1");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "PLA fast profile" })).toBeInTheDocument();
    expect(screen.getByText("Shared bench filament preset.")).toBeInTheDocument();
    expect(screen.getByText("Review before use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download preset JSON/ })).toBeInTheDocument();
  });

  it("keeps legacy unassigned presets independent of the selected printer", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = { ...workspaceTestPrinter("orca-printer"), name: "Bench printer" };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    const legacy = {
      id: "legacy-1",
      kind: "filament",
      title: "Legacy PLA",
      description: "",
      content: JSON.stringify({ type: "filament", name: "Legacy PLA", filament_settings_id: ["x"] }),
      tags: [],
      public: false,
      version: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    setAccountStored("companionAssets", [legacy]);
    stubWorkspacePrinterApi(printer, { companionAssets: [legacy] });

    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
    if (screen.queryByRole("button", { name: "Open preset editor" })) await userEvent.click(screen.getByRole("button", { name: "Open preset editor" }));

    // The legacy preset (no printerId) is migrated onto the selected printer and
    // shows in its workspace.
    expect(await screen.findByRole("button", { name: /Legacy PLA/ })).toBeInTheDocument();
    await waitFor(() => {
      const stored = getAccountStored<Array<{ printerId?: string | null }>>("companionAssets", []);
      expect(stored[0].printerId).toBeUndefined();
    });
  }, 10000);
});
