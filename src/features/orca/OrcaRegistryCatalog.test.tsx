import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TestQueryClientProvider } from "../../test/appTestUtils";
import { renderWithUi } from "../../test/uiTestUtils";
import { OrcaRegistryCatalog } from "./OrcaRegistryCatalog";

describe("Orca public catalog", () => {
  it("keeps results visible and pagination disabled until changed filters finish loading", async () => {
    let finish: ((response: Response) => void) | undefined;
    const asset = { kind: "machine", title: "Fine QIDI", description: "Details", publicSlug: "fine", version: "1", tags: [] };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ assets: [asset], nextOffset: 24, nozzleSizes: ["0.2"] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    renderWithUi(<TestQueryClientProvider><MemoryRouter><OrcaRegistryCatalog /></MemoryRouter></TestQueryClientProvider>);
    await screen.findByRole("heading", { name: "Fine QIDI" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Profile type" }), "machine");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Fine QIDI" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByText("Loading shared profiles…")).not.toBeInTheDocument();

    await act(async () => { finish?.(Response.json({ assets: [{ ...asset, title: "Filtered QIDI" }], nextOffset: null, nozzleSizes: ["0.2"] })); });
    expect(await screen.findByRole("heading", { name: "Filtered QIDI" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Fine QIDI" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining("kind=machine"), expect.anything());
  });

  it("shows nozzle tags and share-page links, and sends filters to the public catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ assets: [{ kind: "machine", title: "Fine QIDI", description: "Details", publicSlug: "fine", version: "1", tags: ["0.2 mm nozzle", "QIDI Plus 4"] }], nextOffset: null, nozzleSizes: ["0.2", "0.4"] }));
    vi.stubGlobal("fetch", fetcher);
    renderWithUi(<TestQueryClientProvider><MemoryRouter><OrcaRegistryCatalog /></MemoryRouter></TestQueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Fine QIDI" })).toBeVisible();
    expect(screen.getByRole("link", { name: "View profile" })).toHaveAttribute("href", "/assets/fine");
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Nozzle size" }), "0.2");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Profile type" }), "machine");
    await userEvent.type(screen.getByRole("textbox", { name: "Search Orca profiles" }), "QIDI");
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("q=QIDI&kind=machine&nozzle=0.2"), expect.anything()));
  });
});
