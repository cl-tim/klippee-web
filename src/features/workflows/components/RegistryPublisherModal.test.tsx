import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicPackageApprovalStatus } from "../../../app/types";
import { RegistryPublisherModal } from "./RegistryPublisherModal";

const state = vi.hoisted(() => ({
  publish: vi.fn(),
  listing: true,
}));
vi.mock("../../../app/contexts/usePrinterContext", () => ({ usePrinterContext: () => ({
  selectedPrinter: { id: "printer", name: "example2", repositoryId: "repo", packageIds: [] },
}) }));
vi.mock("../../../app/contexts/usePackageContext", () => ({ usePackageContext: () => ({
  availablePackages: state.listing ? [{ id: "public", sourcePackageId: "printer-printer-workspace", title: "QIDI configuration", printer: "QIDI Plus 4", hardware: ["Klipper"], tags: [] }] : [],
  privatePackages: [], buildStatus: "", publishStatus: "", workspacePublishable: true,
  packageDraft: { title: "QIDI configuration", description: "", printer: "QIDI Plus 4", hardware: "Klipper", tags: "" },
  publishWorkspacePackage: state.publish,
}) }));

const currentStatus: PublicPackageApprovalStatus = {
  linked: true, autoUpdateEnabled: true, autoUpdateError: null,
  approvedVersionId: "version-7", currentAppliedVersionId: "version-7", hasUnpublishedAppliedVersion: false,
};
function mount({ status = currentStatus, statusFailure = false, statusPending = false, candidateFailure = false, content = "[printer]\n" } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/status")) {
      if (statusPending) return new Promise<Response>(() => {});
      return statusFailure ? Response.json({}, { status: 500 }) : Response.json({ status });
    }
    return candidateFailure ? Response.json({}, { status: 500 }) : Response.json({ candidate: {
      files: [{ content, path: "printer.cfg", role: "printer", public: false }],
      versionNumber: 7, versionId: "version-7", repositoryId: "repo", appliedAt: "2026-10-18T01:00:00Z",
    } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><RegistryPublisherModal open onClose={() => {}} /></QueryClientProvider></MantineProvider>);
}
beforeEach(() => { state.listing = true; state.publish.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Registry publisher presentation", () => {
  it("shows a current automatic listing without an approval prompt and keeps details collapsed", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Public listing is up to date" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and republish" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Republish applied version" })).toBeEnabled();
    expect(screen.getByText("Applied configuration", { selector: "strong" }).closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Listing details", { selector: "strong" }).closest("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Applied candidate source for printer.cfg")).not.toBeVisible();
    await userEvent.click(screen.getByText("Listing details", { selector: "strong" }));
    await userEvent.type(screen.getByLabelText("Listing title"), " updated");
    expect(screen.getByRole("button", { name: "Publish listing changes" })).toBeEnabled();
  });

  it("explains a paused update once and preserves retry and manual approval", async () => {
    mount({ status: { ...currentStatus, autoUpdateError: "Review machine-specific settings before publishing.", hasUnpublishedAppliedVersion: true }, content: "[extruder]\nmax_temp: 300\n" });
    expect(await screen.findByRole("heading", { name: "Automatic updates paused" })).toBeInTheDocument();
    expect(screen.getAllByText("Review machine-specific settings before publishing.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry automatic update" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Approve and republish" }));
    const confirmation = screen.getByRole("group", { name: "Confirm public publication of QIDI configuration" });
    expect(within(confirmation).getByText(/safety warning/)).toBeInTheDocument();
    expect(state.publish).not.toHaveBeenCalled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Approve and republish" }));
    await waitFor(() => expect(state.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ versionId: "version-7" }), true));
  });

  it("offers first publication without a redundant published status", async () => {
    state.listing = false;
    mount();
    expect(await screen.findByRole("heading", { name: "Ready for first publication" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish to Shared Configs" })).toBeEnabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("waits for publication status instead of claiming the listing is current", async () => {
    mount({ statusPending: true });
    expect(await screen.findByRole("heading", { name: "Checking publication status..." })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Public listing is up to date" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and republish" })).toBeDisabled();
  });

  it("offers retry when publication status fails and does not claim the listing is current", async () => {
    mount({ statusFailure: true });
    expect(await screen.findByRole("heading", { name: "Publication status unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Public listing is up to date" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Approve and republish" })).toBeDisabled();
  });

  it("does not claim current when the applied files fail to load", async () => {
    mount({ candidateFailure: true });
    expect(await screen.findByRole("heading", { name: "Applied configuration unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Public listing is up to date" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
