import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "./App";
import { repositoryFilesRevision } from "./repositoryRevision";
import { fetchState, getAccountStored, jsonResponse, setAccountStored, stubApiRoutes, workspaceTestPrinter } from "./test/appTestUtils";
import type { ConfigFile } from "./types";

it.each(["replace", "add"])("reviews, cancels and confirms a single-file %s while retaining unrelated local edits and printer state", async mode => {
  fetchState.user = { id: "u1", displayName: "Owner", avatarUrl: null, providers: [] };
  const saved: ConfigFile = { path: "printer.cfg", content: "# saved printer\n", public: false, role: "printer" };
  const macro: ConfigFile = { path: "macros.cfg", content: "# current macro\n", public: false, role: "macro" };
  const current = mode === "replace" ? [{ ...saved, content: "# current printer\n" }, macro] : [macro];
  let cloud = current, revision = await repositoryFilesRevision(current);
  const history = [
    { id: 1, previousId: null, createdAt: "2026-11-01T00:00:00Z", message: "Saved source", source: "capture", files: [saved] },
    { id: 2, previousId: 1, createdAt: "2026-11-02T00:00:00Z", message: "Current config", source: "capture", files: current },
  ];
  const localMacro = "# unsaved local macro\n";
  const printer = { ...workspaceTestPrinter(), repositoryId: "repo-restore", appliedVersionId: 2, latestVersionId: 2, history,
    workspaceBaseRevision: revision, workspaceBaseFiles: current, workspaceDrafts: { "macros.cfg": localMacro }, workspaceFilePath: "macros.cfg" };
  setAccountStored("printers", [printer]); setAccountStored("selectedPrinterId", printer.id); setAccountStored("history", history);
  setAccountStored("workspaceDrafts", printer.workspaceDrafts); setAccountStored("workspaceFilePath", "macros.cfg"); setAccountStored("workspaceContent", localMacro);
  const calls: Array<{ url: string; method: string }> = [];
  const stages: Array<{ baseRevision: string; files: ConfigFile[] }> = [];
  stubApiRoutes(async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
    if (url.includes("/versions?")) return jsonResponse({ versions: history.map(version => ({
      id: `v${version.id}`, previous_version_id: version.previousId ? `v${version.previousId}` : null,
      version_number: version.id, created_at: version.createdAt, source: version.source, message: version.message, files: version.files,
    })), desired: { files: cloud, revision, pending: true, createdAt: "2026-11-02T00:00:00Z", source: "web-editor", versionId: null, versionNumber: 2 } });
    if (url.endsWith("/pending") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: string; files: ConfigFile[] }; stages.push(body);
      if (body.baseRevision !== revision) return jsonResponse({ code: "desired_configuration_conflict" }, 409);
      cloud = body.files; revision = await repositoryFilesRevision(cloud);
      return jsonResponse({ desired: { revision, createdAt: "2026-11-02T00:01:00Z" } });
    }
    if (url.endsWith("/sync-status")) return jsonResponse({ printer, latestVersion: { version_number: 2 }, appliedVersion: { version_number: 2 }, pendingConfiguration: null });
    if (url.endsWith("/sync-tokens")) return jsonResponse({ tokens: [] });
    if (url.endsWith("/api/app-state")) return jsonResponse(init?.method === "PUT" ? { ok: true, revision: "backup" } : { state: null, updatedAt: null });
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^Recovery/ }));
  const dialog = await screen.findByRole("dialog", { name: "Configuration recovery" });
  await userEvent.click(within(dialog).getByRole("button", { name: /Recovery point 1/ }));
  const reviewButton = within(dialog).getByRole("button", { name: "Review file restore" });
  expect(reviewButton).toBeDisabled();
  await userEvent.selectOptions(within(dialog).getByLabelText("File to restore"), "printer.cfg");
  await userEvent.click(reviewButton);
  expect(await within(dialog).findByLabelText("Restore diff for printer.cfg")).toHaveTextContent("+ # saved printer");
  if (mode === "replace") expect(within(dialog).getByLabelText("Restore diff for printer.cfg")).toHaveTextContent("− # current printer");
  expect(stages.some(stage => stage.files.some(file => file.content === saved.content))).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel file restore" }));
  expect(getAccountStored("workspaceDrafts", {})).toEqual({ "macros.cfg": localMacro });
  await userEvent.click(reviewButton);
  await within(dialog).findByRole("button", { name: "Restore file to draft" });
  const expectedRevision = revision;
  await userEvent.click(within(dialog).getByRole("button", { name: "Restore file to draft" }));
  await within(dialog).findByText(/Restored printer.cfg from recovery point 1 to the pending draft/);
  const restored = stages.find(stage => stage.files.some(file => file.content === saved.content));
  expect(restored?.baseRevision).toBe(expectedRevision);
  expect(restored?.files).toHaveLength(2);
  expect(restored?.files.find(file => file.path === "macros.cfg")?.content).toBe(localMacro);
  await waitFor(() => expect(getAccountStored<ConfigFile[]>("workspaceDraftFiles", []).find(file => file.path === "printer.cfg")).toEqual(saved));
  const [stored] = getAccountStored<Array<typeof printer>>("printers", []);
  expect(stored.appliedVersionId).toBe(2); expect(stored.latestVersionId).toBe(2);
  expect(getAccountStored<Array<{ id: number }>>("history", []).map(version => version.id)).toEqual([1, 2]);
  expect(calls.filter(call => call.method === "POST" && /restore|versions|recover|apply/.test(call.url))).toEqual([]);
});
