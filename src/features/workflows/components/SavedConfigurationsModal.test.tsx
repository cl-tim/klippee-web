import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../../test/appTestUtils";
import { renderWithUi } from "../../../test/uiTestUtils";
import { SavedConfigurationsModal } from "./SavedConfigurationsModal";

const old = {
  id: "old/config", name: "old-voron", title: "Old Voron", updated_at: "2026-10-01T00:00:00.000Z",
  latest_version_id: "v2", version_count: 2, pending_draft: 1,
  linked_printer_count: 0, published_listing_count: 0, dependent_version_count: 0,
};
function show() {
  return renderWithUi(<SavedConfigurationsModal open onClose={vi.fn()} />);
}

describe("saved configurations", () => {
  it("shows history and protection reasons; cancel restores focus without deleting anything", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ repositories: [
      old,
      { ...old, id: "active", title: "Active printer", linked_printer_count: 1 },
      { ...old, id: "published", title: "Published", published_listing_count: 1 },
      { ...old, id: "referenced", title: "Referenced", dependent_version_count: 1 },
    ] }));
    vi.stubGlobal("fetch", fetch);
    show();
    const row = await screen.findByRole("article", { name: "Old Voron" });
    expect(within(row).getByText("2 saved versions · Draft saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Active printer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Published" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Referenced" })).toBeDisabled();
    expect(screen.getByText(/Used by a public listing/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Delete Old Voron" });
    await userEvent.click(button);
    expect(screen.getByText(/Files on printers will not be changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(button).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deletes only after confirmation and sends no printer operations", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ repositories: [old] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, deletedRepositoryId: old.id }));
    vi.stubGlobal("fetch", fetch);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old Voron" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete saved configuration" }));
    await screen.findByText(/Deleted “Old Voron” from Klippee. Printer files were not changed/);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("No saved configurations.")).toBeInTheDocument();
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/repos?manage=1", "/api/repos/old%2Fconfig"]);
    expect(fetch).toHaveBeenLastCalledWith("/api/repos/old%2Fconfig", expect.objectContaining({
      method: "DELETE", credentials: "include", body: JSON.stringify({ updatedAt: old.updated_at, latestVersionId: "v2" }),
    }));
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("reloads stale protection after a conflict and requires a new confirmation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ repositories: [old] }))
      .mockResolvedValueOnce(jsonResponse({ error: "This configuration is now linked to a printer." }, 409))
      .mockResolvedValueOnce(jsonResponse({ repositories: [{ ...old, linked_printer_count: 1 }] }));
    vi.stubGlobal("fetch", fetch);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old Voron" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete saved configuration" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Old Voron" })).toBeDisabled());
    expect(screen.getByRole("alert")).toHaveTextContent("now linked to a printer");
    expect(screen.queryByRole("button", { name: "Delete saved configuration" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("allows retry after a failed list request", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse({ repositories: [] }));
    vi.stubGlobal("fetch", fetch);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load saved configurations");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("No saved configurations.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([{}, { repositories: [null] }, { repositories: [{ ...old, linked_printer_count: -1 }] }])(
    "rejects malformed inventory instead of enabling deletion", async body => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
      show();
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: "Delete Old Voron" })).not.toBeInTheDocument();
      expect(screen.queryByText("No saved configurations.")).not.toBeInTheDocument();
    },
  );

  it.each(["network", "malformed"])("reconciles an uncertain %s deletion without claiming success", async mode => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ repositories: [old] }));
    if (mode === "network") fetch.mockRejectedValueOnce(new Error("response lost"));
    else fetch.mockResolvedValueOnce(jsonResponse({ ok: true, deletedRepositoryId: "different-id" }));
    fetch.mockResolvedValueOnce(jsonResponse({ repositories: [] }));
    vi.stubGlobal("fetch", fetch);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old Voron" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete saved configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't confirm deletion");
    expect(screen.queryByText(/Deleted “Old Voron”/)).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("aborts a closed dialog's list request and ignores its late response", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ repositories: [] }));
    vi.stubGlobal("fetch", fetch);
    const first = show();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal: AbortSignal = fetch.mock.calls[0][1].signal;
    first.unmount();
    expect(signal.aborted).toBe(true);
    show();
    await screen.findByText("No saved configurations.");
    await act(async () => { finish?.(jsonResponse({ repositories: [old] })); });
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
