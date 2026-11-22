import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { renderWithUi } from "../../../test/uiTestUtils";
import { jsonResponse } from "../../../test/appTestUtils";
import { PrivatePackagesModal } from "./PrivatePackagesModal";

const pkg = { id: "old/package", name: "old-private", title: "Old private", updated_at: "2026-10-01T00:00:00.000Z",
  linked_printer_count: 0, published_listing_count: 1 };
function mount(onDeleted = vi.fn()) {
  return { onDeleted, ...renderWithUi(<PrivatePackagesModal open onClose={vi.fn()} onDeleted={onDeleted} />) };
}

describe("private package deletion", () => {
  it("explains public-copy retention, requires confirmation and updates the library only on success", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ packages: [pkg] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, deletedPackageId: pkg.id }));
    vi.stubGlobal("fetch", fetch);
    const { onDeleted } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old private" }));
    expect(screen.getByText(/Published Shared Configs copies remain public/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete Old private" })).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(1); expect(onDeleted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete Old private" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete private package" }));
    await screen.findByText(/Deleted “Old private”/);
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith(pkg.id);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/private-packages?manage=1", "/api/private-packages/old%2Fpackage"]);
    expect(fetch).toHaveBeenLastCalledWith("/api/private-packages/old%2Fpackage", expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ updatedAt: pkg.updated_at }), credentials: "include",
    }));
    expect(screen.getByText("No hosted private packages.")).toBeInTheDocument();
  });

  it("protects printer bindings and refreshes a conflict before allowing another confirmation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ packages: [pkg] }))
      .mockResolvedValueOnce(jsonResponse({ error: "Now bound to a printer" }, 409))
      .mockResolvedValueOnce(jsonResponse({ packages: [{ ...pkg, linked_printer_count: 1 }] }));
    vi.stubGlobal("fetch", fetch); const { onDeleted } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old private" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete private package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Now bound");
    expect(screen.getByRole("button", { name: "Delete Old private" })).toBeDisabled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it.each([{}, { packages: [null] }, { packages: [{ ...pkg, linked_printer_count: -1 }] }])(
    "rejects incomplete or malformed inventories", async body => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body))); mount();
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: "Delete Old private" })).not.toBeInTheDocument();
    },
  );

  it("reconciles a lost response without claiming a successful deletion receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ packages: [pkg] }))
      .mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(jsonResponse({ packages: [] })));
    const { onDeleted } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old private" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete private package" }));
    await screen.findByRole("alert");
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith(pkg.id);
    expect(screen.queryByText(/Deleted “Old private”/)).not.toBeInTheDocument();
  });

  it("still removes the browser's cached copy when the dialog closes during a successful deletion", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ packages: [pkg] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch); const { unmount, onDeleted } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Old private" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete private package" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); unmount();
    await act(async () => { finish?.(jsonResponse({ ok: true, deletedPackageId: pkg.id })); });
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith(pkg.id);
  });
});
