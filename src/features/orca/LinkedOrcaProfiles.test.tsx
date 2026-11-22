import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TestQueryClientProvider } from "../../test/appTestUtils";
import { renderWithUi } from "../../test/uiTestUtils";
import { LinkedOrcaProfiles } from "./LinkedOrcaProfiles";

describe("Related Orca profiles", () => {
  it("shows matching nozzle variants on a printer config with working profile links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [
      { title: "example1 fine nozzle", publicSlug: "fine", tags: ["0.2 mm nozzle"] },
      { title: "example1 standard nozzle", publicSlug: "standard", tags: ["0.4 mm nozzle"] },
    ] })));
    renderWithUi(<TestQueryClientProvider><MemoryRouter><LinkedOrcaProfiles configSlug="qidi-config" /></MemoryRouter></TestQueryClientProvider>);
    expect(await screen.findByRole("link", { name: "example1 fine nozzle" })).toHaveAttribute("href", "/assets/fine");
    expect(screen.getByRole("link", { name: "example1 standard nozzle" })).toHaveAttribute("href", "/assets/standard");
    expect(screen.getByText("0.2 mm nozzle")).toBeVisible();
  });
});
