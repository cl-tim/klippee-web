import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestQueryClientProvider, jsonResponse } from "../../test/appTestUtils";
import { renderWithUi } from "../../test/uiTestUtils";
import { PublicAssetView } from "./PublicAssetView";

function renderAssetRoute(slug: string) {
  return renderWithUi(
    <StrictMode>
      <TestQueryClientProvider>
        <MemoryRouter initialEntries={[`/assets/${slug}`]}>
          <Routes>
            <Route element={<PublicAssetView />} path="/assets/:slug" />
          </Routes>
        </MemoryRouter>
      </TestQueryClientProvider>
    </StrictMode>,
  );
}

describe("PublicAssetView", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the not-found state for a missing slug, including under StrictMode double-mount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Companion asset not found" }, 404)));
    renderAssetRoute("missing-preset");
    await waitFor(() => {
      expect(screen.getByText("Preset unavailable")).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(screen.getByText("Companion asset not found")).toBeInTheDocument();
  });

  it("renders a published preset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        asset: {
          content: JSON.stringify({ name: "PLA Fast", type: "filament" }),
          description: "A community filament preset.",
          id: "asset-1",
          kind: "filament",
          publicSlug: "pla-fast",
          publishedAt: "2026-08-01T00:00:00.000Z",
          tags: ["pla"],
          title: "PLA Fast",
          updatedAt: "2026-08-01T00:00:00.000Z",
          version: 3,
        },
      }),
    ));
    renderAssetRoute("pla-fast");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PLA Fast" })).toBeInTheDocument();
    });
    expect(screen.getByText("Download preset JSON")).toBeInTheDocument();
  });

  it("explains how to restore a shared native profile with its inheritance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ asset: {
      content: JSON.stringify({ snapshot: { format: "klippee-orca-profile/v1", nodes: {}, selections: [] } }),
      description: "Fine nozzle profile", id: "native", kind: "machine", publicSlug: "fine", title: "Fine QIDI", tags: ["0.2 mm nozzle"], version: "1",
      printerConfig: { title: "QIDI printer macros", slug: "qidi-config" },
    } })));
    renderAssetRoute("fine");
    expect(await screen.findByRole("button", { name: "Download profile for OrcaSlicer" })).toBeVisible();
    expect(screen.getByText("Review compatible printer names and custom G-code before using it.")).toBeVisible();
    expect(screen.queryByText(/full inheritance chain/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Help for Download profile for OrcaSlicer" }));
    expect(screen.getByText(/full inheritance chain/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Browse Orca profiles" })).toHaveAttribute("href", "/shared-configs?type=orca");
    expect(screen.getByRole("link", { name: "QIDI printer macros" })).toHaveAttribute("href", "/packages/qidi-config");
  });
});
