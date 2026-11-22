import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "./App";
import { repositoryFilesRevision } from "./repositoryRevision";
import { fetchState, getAccountStored, jsonResponse, setAccountStored, stubApiRoutes, workspaceTestPrinter } from "./test/appTestUtils";
import type { ConfigFile } from "./types";

it.each(["pending", "capture", "legacy-capture"])("preserves and explicitly resolves a concurrent %s edit, including its baseline", async (mode) => {
  fetchState.user = { id: "u1", displayName: "Owner", avatarUrl: null, providers: [] };
  const base: ConfigFile[] = [{ path: "printer.cfg", content: "# baseline\n", role: "printer", public: false },
    { path: "macros.cfg", content: "# baseline macro\n", role: "macro", public: false }];
  const localContent = "# local edit\n";
  let cloud = [{ ...base[0], content: "# cloud edit\n" }, { ...base[1], content: "# cloud macro\n" }];
  let revision = await repositoryFilesRevision(cloud);
  const baseRevision = await repositoryFilesRevision(base);
  const history = [{ id: 1, previousId: null, createdAt: "2026-11-01T00:00:00Z", message: "Baseline", source: "capture", files: base }];
  const printer = { ...workspaceTestPrinter(), repositoryId: "repo-conflict", history, workspaceBaseRevision: mode === "legacy-capture" ? undefined : baseRevision,
    workspaceBaseFiles: mode === "legacy-capture" ? undefined : base, workspaceDrafts: { "printer.cfg": localContent }, workspaceFilePath: "printer.cfg" };
  setAccountStored("printers", [printer]); setAccountStored("selectedPrinterId", printer.id);
  setAccountStored("history", history); setAccountStored("workspaceDrafts", printer.workspaceDrafts);
  setAccountStored("workspaceContent", localContent); setAccountStored("workspaceFilePath", "printer.cfg");
  const stages: Array<{ baseRevision: string; files: ConfigFile[] }> = [];
  const capturedFiles = cloud;
  stubApiRoutes(async (url, init) => {
    if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
    if (url.includes("/versions?")) return jsonResponse({ versions: [{ id: "v1", previous_version_id: null,
      version_number: 1, files: base, created_at: history[0].createdAt, message: "Baseline", source: "capture" },
      ...(mode === "pending" ? [] : [{ id: "v2", previous_version_id: "v1", version_number: 2, files: capturedFiles,
        created_at: "2026-11-02T00:00:00Z", message: "New printer capture", source: "capture" }])],
      desired: { createdAt: "2026-11-02T00:00:00Z", files: cloud, pending: mode === "pending", revision,
        source: mode === "pending" ? "web-editor" : "capture", versionId: mode === "pending" ? null : "v2", versionNumber: mode === "pending" ? 1 : 2 } });
    if (url.endsWith("/pending") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: string; files: ConfigFile[] };
      stages.push(body);
      if (body.baseRevision !== revision) return jsonResponse({ code: "desired_configuration_conflict" }, 409);
      cloud = body.files; revision = await repositoryFilesRevision(cloud);
      return jsonResponse({ desired: { createdAt: "2026-11-02T00:01:00Z", revision } });
    }
    if (url.endsWith("/sync-status")) return jsonResponse({ printer, latestVersion: { version_number: 1 }, appliedVersion: null, pendingConfiguration: null });
    if (url.endsWith("/sync-tokens")) return jsonResponse({ tokens: [] });
    if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Review conflict" }, { timeout: 6000 }));
  let dialog = await screen.findByRole("dialog", { name: "Review configuration conflict" });
  expect(within(dialog).getByLabelText("Baseline contents of printer.cfg")).toHaveTextContent("# baseline");
  expect(within(dialog).getByLabelText("Local contents of printer.cfg")).toHaveTextContent("# local edit");
  expect(within(dialog).getByLabelText("Cloud contents of printer.cfg")).toHaveTextContent("# cloud edit");
  await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing locally" }));
  expect(getAccountStored("workspaceDrafts", {})).toEqual({ "printer.cfg": localContent });
  expect(stages).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Review conflict" }));
  dialog = await screen.findByRole("dialog", { name: "Review configuration conflict" });
  await userEvent.click(within(dialog).getByLabelText("Use local for printer.cfg"));
  const expectedRevision = revision;
  await userEvent.click(within(dialog).getByRole("button", { name: "Stage reviewed files" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(stages[1]).toMatchObject({ baseRevision: expectedRevision });
  expect(stages[1].files).toEqual([{ ...base[1], content: "# cloud macro\n" }, { ...base[0], content: localContent }]);
  await waitFor(() => {
    const [saved] = getAccountStored<Array<typeof printer>>("printers", []);
    expect(saved.workspaceBaseRevision).toBe(revision);
    expect(saved.workspaceBaseFiles).toEqual(cloud);
    expect(getAccountStored("workspaceDraftFiles", [])).toEqual(cloud);
  });
  expect(screen.queryByRole("button", { name: "Review conflict" })).not.toBeInTheDocument();
});
