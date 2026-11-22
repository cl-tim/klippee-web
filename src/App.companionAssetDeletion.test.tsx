import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "./App";
import { fetchState, getAccountStored, jsonResponse, stubApiRoutes } from "./test/appTestUtils";

const preset = { id: "saved-preset", kind: "filament", title: "Saved PLA", description: "", tags: [], public: false, version: "1",
  content: JSON.stringify({ type: "filament", name: "Saved PLA" }), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
function install(asset = preset, blocked = false) {
  fetchState.user = { id: "u1", displayName: "Owner", avatarUrl: null, providers: [] };
  let deleted = false;
  return stubApiRoutes((url, init) => {
    if (url.endsWith(`/api/companion-assets/${asset.id}`) && init?.method === "DELETE") {
      if (blocked) return jsonResponse({ error: "Preset is attached to a private configuration package" }, 409);
      deleted = true; return jsonResponse({ ok: true, deletedAssetId: asset.id });
    }
    if (url.endsWith("/api/companion-assets")) return jsonResponse({ assets: deleted ? [] : [asset] });
  });
}
async function openEditor() {
  await userEvent.click(await screen.findByRole("link", { name: "Orca Workspace" }));
  await userEvent.click(await screen.findByRole("button", { name: "Open preset editor" }));
}

it("keeps a cloud-deleted preset absent after reloading the application", async () => {
  const fetch = install(); const first = render(<App />); await openEditor();
  await userEvent.click(await screen.findByRole("button", { name: preset.title }));
  await userEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  expect(screen.getByText(/Published copies and their public configuration links remain available/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Delete preset" }));
  await waitFor(() => expect(getAccountStored("companionAssets", [])).toEqual([]));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  first.unmount(); render(<App />); await openEditor();
  await screen.findByText(/No editable presets yet/);
  expect(screen.queryByRole("button", { name: preset.title })).not.toBeInTheDocument();
});

it("retains the preset and confirmation when a private-package attachment blocks deletion", async () => {
  install(preset, true); render(<App />); await openEditor();
  await userEvent.click(await screen.findByRole("button", { name: preset.title }));
  await userEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Delete preset" }));
  const confirmation = screen.getByRole("group", { name: "Confirm delete preset" });
  expect(await within(confirmation).findByRole("alert")).toHaveTextContent("private configuration package");
  expect(getAccountStored("companionAssets", [])).toHaveLength(1);
  expect(screen.getByRole("button", { name: preset.title })).toBeInTheDocument();
});

it("lets owners inspect and delete legacy assets without turning them into new presets", async () => {
  const legacy = { ...preset, id: "legacy-saved", title: "Old legacy profile", kind: "slicer", content: "old format" };
  install(legacy); render(<App />); await openEditor();
  await screen.findByText("Other saved assets");
  await userEvent.click(await screen.findByRole("button", { name: legacy.title }));
  expect(screen.getByRole("button", { name: "Update preset" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Delete preset" }));
  await waitFor(() => expect(getAccountStored("companionAssets", [])).toEqual([]));
});
