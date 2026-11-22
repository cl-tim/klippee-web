import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryAutoUpdateSettings } from "./RegistryAutoUpdateSettings";

const initial = {
  approvedVersionId: "old", currentAppliedVersionId: "current", hasUnpublishedAppliedVersion: true,
  linked: true, autoUpdateEnabled: false, autoUpdateError: null,
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}>
    <RegistryAutoUpdateSettings packageId="listing" />
  </QueryClientProvider></MantineProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("automatic registry update setting", () => {
  it("saves an explicit opt-in and opt-out, using the server-confirmed setting", async () => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      const enabled = options?.method === "PATCH" ? JSON.parse(String(options.body)).enabled : false;
      return Response.json({ status: { ...initial, autoUpdateEnabled: enabled, hasUnpublishedAppliedVersion: !enabled } });
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    const control = await screen.findByRole("switch", { name: "Automatically update this shared listing" });
    expect(control).not.toBeChecked();
    await userEvent.click(control);
    await waitFor(() => expect(control).toBeChecked());
    expect(fetcher).toHaveBeenCalledWith("/api/public-packages/listing/auto-update", expect.objectContaining({
      credentials: "include", method: "PATCH", body: JSON.stringify({ enabled: true }),
    }));
    await userEvent.click(control);
    await waitFor(() => expect(control).not.toBeChecked());
  });

  it("keeps a failed save unchecked and explains the error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => options?.method === "PATCH"
      ? Response.json({ error: "Failed" }, { status: 500 }) : Response.json({ status: initial })));
    mount();
    const control = await screen.findByRole("switch");
    await userEvent.click(control);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save automatic updates to Shared Configs");
    expect(control).not.toBeChecked();
  });

  it("shows a publication problem and retries without changing the enabled setting", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => Response.json({ status: {
      ...initial, autoUpdateEnabled: true, autoUpdateError: options?.method === "PATCH" ? null : "Automatic update needs review",
    } })));
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("needs review");
    await userEvent.click(screen.getByRole("button", { name: "Retry automatic update" }));
    await waitFor(() => expect(screen.queryByText("Automatic update needs review")).not.toBeInTheDocument());
    expect(screen.getByRole("switch")).toBeChecked();
  });
});
