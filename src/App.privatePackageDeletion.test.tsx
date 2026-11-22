import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "./App";
import { fetchState, getAccountStored, jsonResponse, stubApiRoutes } from "./test/appTestUtils";

it("removes a deleted private package from the library while retaining public owner controls", async () => {
  fetchState.user = { id: "u1", displayName: "Owner", avatarUrl: null, providers: [] };
  const privatePkg = { id: "private-old", name: "private-old", title: "Old private copy", version: "1", description: "Old",
    printer: "Test", hardware: [], tags: ["private"], warnings: [], variables: [],
    files: [{ path: "printer.cfg", content: "# config", role: "printer", public: true }] };
  const publicPkg = { ...privatePkg, id: "published-old", publicSlug: "published-old", sourcePackageId: privatePkg.id,
    title: "Published copy", tags: ["public"] };
  let deleted = false;
  stubApiRoutes((url, init) => {
    if (url.endsWith("/api/private-packages?manage=1")) return jsonResponse({ packages: deleted ? [] : [{
      id: privatePkg.id, name: privatePkg.name, title: privatePkg.title, updated_at: "2026-10-01T00:00:00.000Z",
      linked_printer_count: 0, published_listing_count: 1,
    }] });
    if (url.endsWith("/api/private-packages/private-old") && init?.method === "DELETE") {
      deleted = true; return jsonResponse({ ok: true, deletedPackageId: privatePkg.id });
    }
    if (url.endsWith("/api/private-packages")) return jsonResponse({ packages: deleted ? [] : [privatePkg] });
    if (url.endsWith("/api/packages")) return jsonResponse({ packages: [publicPkg] });
    if (url.endsWith("/api/public-packages/published-old/status")) return jsonResponse({ status: {
      linked: false, autoUpdateEnabled: false, autoUpdateError: null, approvedVersionId: null,
      currentAppliedVersionId: null, hasUnpublishedAppliedVersion: false,
    } });
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));
  const opener = await screen.findByRole("button", { name: "Private packages", exact: true });
  await userEvent.click(opener);
  await userEvent.click(await screen.findByRole("button", { name: "Delete Old private copy" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete private package" }));
  await screen.findByText(/Deleted “Old private copy”/);
  await waitFor(() => expect(getAccountStored("privatePackages", [])).toEqual([]));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(opener).toHaveFocus());
  await userEvent.click(await screen.findByRole("button", { name: /Published copy/ }));
  await screen.findByRole("button", { name: /Edit listing/ });
});
