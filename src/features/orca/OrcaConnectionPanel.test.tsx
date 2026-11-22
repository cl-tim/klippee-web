import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UiProvider } from "../../app/UiProvider";
import { OrcaConnectionPanel } from "./OrcaConnectionPanel";

vi.mock("../../app/contexts/useAppShellContext", () => ({ useAppShellContext: () => ({ authUser: { id: "owner" } }) }));
vi.mock("../../app/contexts/usePrinterContext", () => ({ usePrinterContext: () => ({ printers: [{ id: "qidi", name: "example1" }, { id: "example2", name: "example2" }], selectedPrinter: null }) }));
const profile = (id: string, nozzle: string) => ({ id, name: `QIDI ${nozzle}`, kind: "machine", nozzle, custom: true, enabled: true, parent: "QIDI base", printerIds: [] });

describe("Orca profile library", () => {
  it("filters all profile types by nozzle compatibility and searches material and layer tags", async () => {
    const tags = (nozzleSizes: string[], values = {}) => ({ nozzleSizes, nozzleScope: "specific", materials: [], layerHeights: [], printerModels: [], hasCompatibilityRule: false, ...values });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ library: {
      id: "tags", updatedAt: "2026-10-18T02:00:00Z", hostVersion: "2.5",
      profiles: [profile("machine:02", "0.2"), profile("machine:04", "0.4"),
        { ...profile("process:Fine", ""), kind: "process", name: "Fine quality", tags: tags(["0.2"], { layerHeights: ["0.08"] }) },
        { ...profile("process:Clock", ""), kind: "process", name: "Clock", tags: tags(["0.4"], { layerHeights: ["0.2"] }) },
        { ...profile("process:Unknown", ""), kind: "process", name: "Unknown compatibility", tags: tags([], { nozzleScope: "unknown" }) },
        { ...profile("filament:Silk", ""), kind: "filament", name: "Silk", tags: tags(["0.2"], { materials: ["PLA"] }) },
        { ...profile("filament:Universal", ""), kind: "filament", name: "Universal", tags: tags([], { materials: ["PETG"], nozzleScope: "unrestricted" }) },
      ],
    }, setups: [], devices: [] })));
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    expect(await screen.findByRole("tab", { name: "Printer profiles (2)" })).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Nozzle size" }), "0.2");
    expect(screen.getByRole("tab", { name: "Printer profiles (1)" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Custom processes (1)" }));
    expect(screen.getByText("Fine quality", { selector: "strong" })).toBeVisible();
    expect(screen.queryByText("Clock", { selector: "strong" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Nozzle size" }), "0.4");
    expect(screen.getByText("Clock", { selector: "strong" }).closest("summary")).toHaveTextContent("0.4 mm nozzle");
    expect(screen.getByText("Clock", { selector: "strong" }).closest("summary")).toHaveTextContent("0.2 mm layer");
    await userEvent.type(screen.getByRole("textbox", { name: "Search profiles" }), "0.2 mm layer");
    expect(screen.getByText("Clock", { selector: "strong" })).toBeVisible();
    await userEvent.clear(screen.getByRole("textbox", { name: "Search profiles" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Nozzle size" }), "0.2");
    await userEvent.click(screen.getByRole("tab", { name: "Custom filaments (2)" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search profiles" }), "PLA");
    expect(screen.getByText("Silk", { selector: "strong" })).toBeVisible();
    expect(screen.queryByText("Universal", { selector: "strong" })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Search profiles" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Nozzle size" }), "unknown");
    await userEvent.click(screen.getByRole("tab", { name: "Custom processes (1)" }));
    expect(screen.getByText("Unknown compatibility", { selector: "strong" })).toBeVisible();
  });
  it("lists usable restored profiles with readable names, correct counts and working exports and printer links", async () => {
    const prefix = "_local/klippee-restore-701648225c90";
    const supporting = `${prefix}-d1/saved-43f13e10cc2362a93c46`;
    const restored = `${prefix}-d2/restored-0-example1-0.6mm`;
    const restoredId = `machine:${restored}`;
    const fetcher = vi.fn(async () => Response.json({ library: {
      id: "import", updatedAt: "2026-10-17T02:00:00Z", hostVersion: "2.5",
      profiles: [
        { ...profile(`machine:${supporting}`, "0.6"), name: supporting, custom: false },
        { ...profile(restoredId, "0.6"), name: restored, custom: false, parent: supporting },
        { ...profile("factory", "0.4"), name: "QIDI factory profile", custom: false },
        { ...profile("user", "0.4"), name: "example1" },
      ],
    }, setups: [], devices: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    expect(await screen.findByRole("tab", { name: "Printer profiles (3)" })).toBeVisible();
    expect(screen.queryByText(supporting, { selector: "strong" })).not.toBeInTheDocument();
    expect(screen.getByText("example1 0.6mm", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("example1 0.6mm").closest("summary")).toHaveTextContent("Restored");
    expect(screen.getByText("QIDI factory profile").closest("summary")).toHaveTextContent("Built-in");
    expect(screen.getByText("example1", { selector: "strong" }).closest("summary")).toHaveTextContent("Custom");
    await userEvent.type(screen.getByRole("textbox", { name: "Search profiles" }), "example1 0.6mm");
    expect(screen.queryByText("QIDI factory profile")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("example1 0.6mm", { selector: "strong" }));
    expect(screen.getByRole("link", { name: "Export profile for OrcaSlicer: example1 0.6mm" }))
      .toHaveAttribute("href", `/api/orca/library/profile-export?profileId=${encodeURIComponent(restoredId)}`);
    await userEvent.click(screen.getByText("Profile details and printer links", { exact: true }));
    await userEvent.click(screen.getByRole("checkbox", { name: "example1" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/orca/profile-printers", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ profileId: restoredId, printerId: "qidi", linked: true }),
    })));
  });
  it("shows nozzle variants without requiring a physical printer, and keeps setups collapsed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/library") ? { library: {
      id: "import", updatedAt: "2026-10-17T02:00:00Z", hostVersion: "2.5.0-alpha", profiles: [profile("machine:02", "0.2"), profile("machine:06", "0.6"),
        { ...profile("filament:unused", ""), name: "Unused custom PLA", kind: "filament" }],
    } } : { setups: [{ id: "setup", title: "Earlier QIDI setup", createdAt: "2026-10-17T01:00:00Z", selections: [{ name: "Fourth filament", kind: "filament", slot: 3 }] }] }), { headers: { "content-type": "application/json" } })));
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    expect(await screen.findByRole("tab", { name: "Printer profiles (2)" })).toBeVisible();
    expect(screen.getByText("QIDI 0.2")).toBeVisible();
    expect(screen.getByText("QIDI 0.6")).toBeVisible();
    expect(screen.getByText("Earlier QIDI setup")).not.toBeVisible();
    expect(screen.queryByText("Choose a printer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Custom filaments (1)" }));
    expect(screen.getByText("Unused custom PLA")).toBeVisible();
    await userEvent.click(screen.getByText("Unused custom PLA"));
    expect(screen.getByRole("link", { name: "Export profile for OrcaSlicer: Unused custom PLA" })).toHaveAttribute("href", "/api/orca/library/profile-export?profileId=filament%3Aunused");
    await userEvent.click(screen.getByText("Saved setups (1)"));
    await userEvent.click(screen.getByText("Earlier QIDI setup"));
    expect(screen.getByText("Filament 4: Fourth filament")).toBeVisible();
    expect(screen.getByRole("link", { name: "Export saved setup" })).toHaveAttribute("href", "/api/orca/setups/setup");
  });
  it("creates an account-wide import code and lets the user revoke it", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method });
      const data = url.endsWith("/library") ? { library: null } : url.endsWith("/setups") ? { setups: [] }
        : init.method === "POST" ? { id: "grant", code: "https://klippee.xyz/#private", expiresAt: new Date(Date.now() + 600_000).toISOString() } : { ok: true };
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    }));
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Import from OrcaSlicer" }));
    expect(await screen.findByLabelText("Import code")).toHaveValue("https://klippee.xyz/#private");
    expect(calls).toContainEqual({ url: "/api/orca/connection", method: "POST" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel code" }));
    await waitFor(() => expect(screen.queryByLabelText("Import code")).not.toBeInTheDocument());
    expect(calls).toContainEqual({ url: "/api/orca/connections/grant", method: "DELETE" });
  });
  it("creates a read-only browse code separately from upload codes", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const data = url.endsWith("/library") ? { library: null } : url.endsWith("/setups") ? { setups: [] } : { id: "browse-grant", code: "https://klippee.xyz/#browse", expiresAt: new Date(Date.now() + 600_000).toISOString() };
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    }));
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Browse library in OrcaSlicer" }));
    expect(await screen.findByText("Browse and restore inside OrcaSlicer")).toBeVisible();
    expect(calls).toContain("/api/orca/pair-connection");
    expect(screen.getByText(/New connections start read-only/)).toBeVisible();
  });
  it("lists remembered installations and disconnects only the chosen one", async () => {
    let connected = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (init.method === "DELETE") connected = false;
      return new Response(JSON.stringify(url.endsWith("/devices") ? { devices: connected ? [{ id: "device-1", createdAt: "2026-10-17T02:00:00Z", lastUsedAt: "2026-10-17T02:10:00Z" }] : [] }
        : url.endsWith("/library") ? { library: null } : { setups: [] }), { headers: { "content-type": "application/json" } });
    }));
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    await userEvent.click(await screen.findByText("Connected Orca installations (1)"));
    await userEvent.click(screen.getByRole("button", { name: /Disconnect Orca connected/ }));
    expect(await screen.findByText("Connected Orca installations (0)")).toBeVisible();
    expect(calls).toContain("/api/orca/devices/device-1");
  });
  it("lets the owner enable uploads on one existing connection", async () => {
    let uploadsEnabled = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") uploadsEnabled = JSON.parse(String(init.body)).uploadsEnabled;
      return new Response(JSON.stringify(url.endsWith("/devices") ? { devices: [{ id: "device-1", createdAt: "2026-10-17T02:00:00Z", lastUsedAt: "2026-10-17T02:10:00Z", uploadsEnabled }] }
        : url.endsWith("/library") ? { library: null } : { setups: [] }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    await userEvent.click(await screen.findByText("Connected Orca installations (1)"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Allow imports and saves for Orca connected/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Allow imports and saves for Orca connected/ })).toBeChecked());
    expect(fetcher).toHaveBeenCalledWith("/api/orca/devices/device-1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ uploadsEnabled: true }) }));
    await userEvent.click(screen.getByRole("button", { name: "Import in the Orca plugin" }));
    expect(await screen.findByText(/Your saved connection is used; no code is needed/)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalledWith("/api/orca/connection", expect.anything());
    await userEvent.click(screen.getByText("Saved setups (0)"));
    await userEvent.click(screen.getByRole("button", { name: "Save setup in the Orca plugin" }));
    expect(await screen.findByText(/choose Review current setup, then confirm the upload/)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalledWith("/api/orca/setup-connection", expect.anything());
  });
  it("offers independent optional links to several physical printers", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ library: { id: "import", updatedAt: "2026-10-17T02:00:00Z", hostVersion: "2.5", profiles: [profile("machine:02", "0.2")] }, setups: [] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OrcaConnectionPanel /></UiProvider>);
    await userEvent.click(await screen.findByText("QIDI 0.2"));
    await userEvent.click(screen.getByText("Profile details and printer links", { exact: true }));
    expect(screen.getByRole("checkbox", { name: "example2" })).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "example1" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/orca/profile-printers", expect.objectContaining({ method: "PUT", body: JSON.stringify({ profileId: "machine:02", printerId: "qidi", linked: true }) })));
  });
});
