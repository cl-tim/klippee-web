import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TestQueryClientProvider } from "../../test/appTestUtils";
import { renderWithUi } from "../../test/uiTestUtils";
import { OrcaProfilePublisher } from "./OrcaProfilePublisher";
import type { OrcaPublicationReview } from "./orcaPublication";

const review: OrcaPublicationReview = { importId: "import-1", candidateHash: "exact-candidate", title: "QIDI fine", description: "", kind: "machine",
  content: '{"snapshot":{"format":"klippee-orca-profile/v1"}}', tags: ["0.2 mm nozzle"], findings: [], publicUrl: null };
function show(candidate = review) {
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  const published = vi.fn(), close = vi.fn();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
    ? Response.json({ asset: { publicUrl: "https://klippee.test/assets/fine" } }) : Response.json({ review: candidate }));
  vi.stubGlobal("fetch", fetcher);
  renderWithUi(<TestQueryClientProvider><OrcaProfilePublisher profileId="machine:fine" onPublished={published} onClose={close} /></TestQueryClientProvider>);
  return { published, close, fetcher };
}
describe("Orca profile publishing", () => {
  it("keeps field help hidden until requested and does not change settings or close the review", async () => {
    const { fetcher, close } = show();
    const help = await screen.findByRole("button", { name: "Help for Automatically update after Orca re-imports" });
    const explanation = "Update this listing from the latest saved profile and future imports. Findings can pause updates for review.";
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    help.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText(explanation)).toBeVisible();
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("switch", { name: "Automatically update after Orca re-imports" })).not.toBeChecked();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(explanation)).not.toBeInTheDocument());
    expect(help).toHaveFocus();
    expect(close).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Help for Related printer config" }));
    expect(await screen.findByText(/Choose your published configuration that supplies/)).toBeVisible();
    await userEvent.click(screen.getByRole("textbox", { name: "Description" }));
    await waitFor(() => expect(screen.queryByText(/Choose your published configuration that supplies/)).not.toBeInTheDocument());
  });
  it("requires explicit public review, submits the exact server candidate, and exposes the share link", async () => {
    const { published, fetcher } = show();
    const button = await screen.findByRole("button", { name: "Publish to Shared Configs" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Public name" }), " renamed");
    await userEvent.click(screen.getByRole("checkbox", { name: /want anyone/ }));
    await userEvent.click(button);
    await waitFor(() => expect(published).toHaveBeenCalledOnce());
    const call = fetcher.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ profileId: "machine:fine", importId: "import-1", candidateHash: "exact-candidate",
      title: "QIDI fine renamed", description: "", confirmPublic: true, acknowledgeSafetyWarnings: false, autoUpdateEnabled: false, printerConfigSlug: null });
    expect(screen.getByRole("link", { name: "View public listing" })).toHaveAttribute("href", "https://klippee.test/assets/fine");
  });
  it("requires a separate warning acknowledgement and keeps blocked profiles private", async () => {
    show({ ...review, findings: [{ path: "orca-profile.json", severity: "warn", message: "Contains a local address" }] });
    await screen.findByRole("button", { name: "Publish to Shared Configs" });
    await userEvent.click(screen.getByRole("checkbox", { name: /want anyone/ }));
    expect(screen.getByRole("button", { name: "Publish to Shared Configs" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /accept them/ }));
    expect(screen.getByRole("button", { name: "Publish to Shared Configs" })).toBeEnabled();
  });
  it("does not offer a way to override detected secrets", async () => {
    show({ ...review, findings: [{ path: "orca-profile.json", severity: "block", message: "Credential detected" }] });
    await screen.findByText("Blocked: Credential detected");
    await userEvent.click(screen.getByRole("checkbox", { name: /want anyone/ }));
    expect(screen.getByRole("button", { name: "Publish to Shared Configs" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: /accept them/ })).not.toBeInTheDocument();
  });
  it("reviews warnings and credentials introduced while editing the public description", async () => {
    show();
    const button = await screen.findByRole("button", { name: "Publish to Shared Configs" });
    await userEvent.click(screen.getByRole("checkbox", { name: /want anyone/ }));
    const description = screen.getByRole("textbox", { name: "Description" });
    await userEvent.type(description, "My printer at 192.168.1.2");
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /accept them/ }));
    expect(button).toBeEnabled();
    await userEvent.clear(description);
    await userEvent.type(description, "password: very-private-value");
    expect(button).toBeDisabled();
    await userEvent.clear(description);
    await userEvent.type(description, "A fine nozzle profile");
    expect(button).toBeEnabled();
  });
  it("shows a stale-library error without reporting a successful publication", async () => {
    const { fetcher, published } = show();
    await screen.findByRole("button", { name: "Publish to Shared Configs" });
    fetcher.mockImplementationOnce(async () => Response.json({ error: "Your library changed. Close this review and open it again before publishing." }, { status: 409 }));
    await userEvent.click(screen.getByRole("checkbox", { name: /want anyone/ }));
    await userEvent.click(screen.getByRole("button", { name: "Publish to Shared Configs" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your library changed");
    expect(published).not.toHaveBeenCalled();
  });
  it("saves automatic updates and a related config without republishing or changing listing metadata", async () => {
    const candidate = { ...review, publicUrl: "https://klippee.test/assets/fine", autoUpdateEnabled: false,
      printerConfigs: [{ slug: "qidi-config", title: "QIDI printer macros" }] };
    const { fetcher, published } = show(candidate);
    await screen.findByRole("button", { name: "Republish profile" });
    fetcher.mockImplementation(async (_url, options) => {
      const input = JSON.parse(String(options?.body));
      return Response.json({ publication: { autoUpdateEnabled: input.autoUpdateEnabled, autoUpdateError: null,
        printerConfig: input.printerConfigSlug ? candidate.printerConfigs[0] : null } });
    });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Related printer config" }), "qidi-config");
    await waitFor(() => expect(published).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("switch", { name: "Automatically update after Orca re-imports" }));
    await waitFor(() => expect(published).toHaveBeenCalledTimes(2));
    const updates = fetcher.mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(updates).toHaveLength(2);
    expect(JSON.parse(String(updates[1][1]?.body))).toEqual({ profileId: "machine:fine", autoUpdateEnabled: true, printerConfigSlug: "qidi-config" });
    expect(screen.getByRole("switch", { name: "Automatically update after Orca re-imports" })).toBeChecked();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
  it("reports paused automatic updates and allows an explicit retry", async () => {
    const { fetcher } = show({ ...review, publicUrl: "https://klippee.test/assets/fine", autoUpdateEnabled: true, autoUpdateError: "Automatic update needs review." });
    await screen.findByText("Automatic update needs review.");
    fetcher.mockImplementationOnce(async () => Response.json({ publication: { autoUpdateEnabled: true, autoUpdateError: null, printerConfig: null } }));
    await userEvent.click(screen.getByRole("button", { name: "Retry automatic update" }));
    expect(await screen.findByText("Publication settings saved.")).toBeVisible();
    expect(screen.queryByText("Automatic update needs review.")).not.toBeInTheDocument();
  });
});
