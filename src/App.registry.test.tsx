import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { packages } from "./data";
import {
  fetchState,
  getAccountStored,
  jsonResponse,
  requestUrl,
  setAccountStored,
  stubApiRoutes,
  stubWorkspacePrinterApi,
  workspaceTestPrinter,
} from "./test/appTestUtils";

describe("App registry and publishing", () => {
  it("preserves direct public package URLs as shareable detail routes", async () => {
    window.history.pushState(null, "", "/packages/klipper-cartesian-starter");

    render(<App />);

    expect(await screen.findByRole("region", { name: "Klipper Cartesian Starter" })).toBeInTheDocument();
    const fileNavigation = screen.getByRole("navigation", { name: "Configuration files" });
    expect(screen.getByLabelText("Source for printer.cfg")).toHaveTextContent("[include macros/startup.cfg]");

    await userEvent.click(within(fileNavigation).getByRole("button", { name: /startup\.cfg/i }));

    expect(screen.getByLabelText("Source for macros/startup.cfg")).toHaveTextContent("[gcode_macro START_PRINT]");
    expect(screen.getByRole("button", { name: "Configure for a printer" })).toBeInTheDocument();
    expect(screen.getByText("http://localhost:3000/packages/klipper-cartesian-starter")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/packages/klipper-cartesian-starter");
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
  });

  it("does not mix the owner's private copy into Shared Configs results", async () => {
    const privatePackage = {
      ...packages[0],
      id: "private-registry-package",
      tags: ["private"],
      title: "Registry-only package",
    };
    const publicPackage = {
      ...privatePackage,
      id: "registry-only-package-0123456789abcdef",
      publicSlug: "registry-only-package-0123456789abcdef",
      sourcePackageId: privatePackage.id,
      tags: ["public"],
    };
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [privatePackage] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [publicPackage] });
        if (url.includes("/api/printers")) return jsonResponse({ printers: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });
    window.history.pushState(null, "", "/shared-configs");

    render(<App />);

    await waitFor(() => expect(screen.getAllByText("Registry-only package")).toHaveLength(1));
    const tags = screen.getByRole("combobox", { name: "Filter packages by tag" });
    expect(within(tags).queryByRole("option", { name: "private" })).not.toBeInTheDocument();
    expect(within(tags).getByRole("option", { name: "public" })).toBeInTheDocument();
    await userEvent.selectOptions(tags, "public");
    expect(screen.getAllByText("Registry-only package")).toHaveLength(1);
    await userEvent.selectOptions(tags, "all");
  });

  it("loads a published workspace config by its public slug without signing in", async () => {
    const publicSlug = "workspace-share-2026-07-24-0123456789abcdef";
    const publishedPackage = {
      ...packages[0],
      id: publicSlug,
      publicUpdatedAt: "2026-07-24T09:00:00.000Z",
      publicSlug,
      sourcePackageId: "private-workspace-package",
      title: "Published Workspace Config",
    };
    const fetchMock = stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: null });
        if (url.endsWith(`/api/packages/${publicSlug}`)) return jsonResponse({ package: publishedPackage });
        if (url.endsWith("/api/packages")) {
          return jsonResponse({
            packages: [{
              ...publishedPackage,
              files: publishedPackage.files.map((file) => ({ ...file, content: "" })),
            }],
          });
        }
        return jsonResponse({});
      });
    window.history.pushState(null, "", `/packages/${publicSlug}`);

    render(<App />);

    expect(await screen.findByRole("region", { name: "Published Workspace Config" })).toBeInTheDocument();
    expect(screen.getByLabelText("Source for printer.cfg")).toHaveTextContent("[include macros/startup.cfg]");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith("/api/packages"))).toBe(true);
    });
    expect(screen.getByLabelText("Source for printer.cfg")).toHaveTextContent("[include macros/startup.cfg]");
    expect(screen.getByText(`http://localhost:3000/packages/${publicSlug}`)).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/packages/${publicSlug}`);
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
  });

  it("lets the owner edit public listing metadata from the shared config workspace", async () => {
    const publicSlug = "owned-config-0123456789abcdef";
    const privatePackage = {
      ...packages[0],
      id: "owned-private-config",
      tags: ["private", "starter"],
    };
    const publicPackage = {
      ...privatePackage,
      id: publicSlug,
      publicSlug,
      sourcePackageId: privatePackage.id,
      tags: ["public", "starter"],
      title: "Owned public config",
      tracksAppliedConfiguration: true,
    };
    let patchedListing: Record<string, unknown> | null = null;
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [] });
      if (url.endsWith("/api/repos")) return jsonResponse({ repositories: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [privatePackage] });
      if (url.endsWith(`/api/public-packages/${publicSlug}/status`)) {
        return jsonResponse({
          status: {
            approvedVersionId: "version-approved",
            currentAppliedVersionId: "version-newly-applied",
            hasUnpublishedAppliedVersion: true,
            linked: true,
          },
        });
      }
      if (url.endsWith(`/api/public-packages/${publicSlug}`) && init?.method === "PATCH") {
        patchedListing = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          package: {
            ...publicPackage,
            ...patchedListing,
            id: publicSlug,
            publicSlug,
          },
          shareUrl: `https://klippee.xyz/packages/${publicSlug}`,
        });
      }
      if (url.endsWith(`/api/packages/${publicSlug}`)) return jsonResponse({ package: publicPackage });
      if (url.endsWith("/api/packages")) return jsonResponse({ packages: [publicPackage] });
      return jsonResponse({});
    });
    window.history.pushState(null, "", `/packages/${publicSlug}`);

    render(<App />);

    expect(await screen.findByText("A newer applied configuration is still private")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Edit listing" }));
    await userEvent.click(screen.getByRole("button", { name: "Help for Edit public listing" }));
    expect(screen.getByText(/Saving does not approve or change the public configuration files/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const title = screen.getByRole("textbox", { name: "Listing title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Updated public config");
    await userEvent.type(screen.getByRole("combobox", { name: "Search tags" }), "qidi{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save listing" }));

    await waitFor(() => expect(patchedListing).toMatchObject({
      tags: ["starter", "qidi"],
      title: "Updated public config",
    }));
    expect(await screen.findByRole("heading", { name: "Updated public config" })).toBeInTheDocument();
    expect(screen.getByText("A newer applied configuration is still private")).toBeInTheDocument();
  });

  it("publishes the reviewed applied candidate without leaking the editor draft", async () => {
    const consoleError = vi.spyOn(console, "error");
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const workspaceFile = {
      content: "# APPLIED_CANDIDATE\n[extruder]\nmax_temp: 300\nserial: ${KLIPPEE:mcu_serial}\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const history = [{
      createdAt: "2026-07-18T00:00:00.000Z",
      files: [workspaceFile],
      id: 1,
      message: "Imported config",
      previousId: null,
      source: "capture",
    }];
    const editedWorkspaceFile = {
      ...workspaceFile,
      content: "# PRIVATE_EDITOR_DRAFT\ntoken: draft-secret-value\n",
    };
    const printer = {
      ...workspaceTestPrinter("publish-printer"),
      appliedVersionId: 1,
      history,
      latestVersionId: 1,
      repositoryId: "repo-publish-printer",
      workspaceDraftFiles: [editedWorkspaceFile],
      workspaceDrafts: { [workspaceFile.path]: editedWorkspaceFile.content },
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", workspaceFile.path);
    setAccountStored("workspaceContent", editedWorkspaceFile.content);
    setAccountStored("workspaceDraftFiles", [editedWorkspaceFile]);
    setAccountStored("workspaceDrafts", { [workspaceFile.path]: editedWorkspaceFile.content });
    let savedPrivatePackageId = "";
    let savedPrivatePackage: Record<string, unknown> | null = null;
    let publishedPackageId = "";
    let publishedPrinterId = "";
    let publishedRepositoryId = "";
    let publishedExpectedVersionId = "";
    let versionWriteAttempted = false;
    stubApiRoutes((url, init) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.includes("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.includes("/api/private-packages") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { package: { id: string } & Record<string, unknown> };
          savedPrivatePackageId = body.package.id;
          savedPrivatePackage = body.package;
          return jsonResponse({ savedAt: "2026-07-18T00:00:00.000Z" });
        }
        if (url.includes("/api/public-packages") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            expectedAppliedVersionId: string;
            packageId: string;
            printerId: string;
            repositoryId: string;
          };
          publishedPackageId = body.packageId;
          publishedPrinterId = body.printerId;
          publishedRepositoryId = body.repositoryId;
          publishedExpectedVersionId = body.expectedAppliedVersionId;
          expect(versionWriteAttempted).toBe(false);
          return jsonResponse({
            package: {
              ...packages[0],
              id: "workspace-share-0123456789abcdef",
              publicSlug: "workspace-share-0123456789abcdef",
              sourcePackageId: body.packageId,
            },
            shareUrl: "https://klippee.xyz/packages/workspace-share-0123456789abcdef",
          });
        }
        if (url.endsWith("/api/public-packages/workspace-share-0123456789abcdef/status")) {
          return jsonResponse({ status: { approvedVersionId: "repo-publish-version-1", currentAppliedVersionId: "repo-publish-version-1", hasUnpublishedAppliedVersion: false, linked: true } });
        }
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.endsWith(`/api/printers/${printer.id}/publication-candidate`)) {
          return jsonResponse({
            candidate: {
              appliedAt: history[0].createdAt,
              files: history[0].files,
              repositoryId: printer.repositoryId,
              versionId: "repo-publish-version-1",
              versionNumber: 1,
            },
          });
        }
        if (url.includes("/api/printers")) return jsonResponse({ printers: [printer] });
        if (url.includes("/api/repos/repo-publish-printer/versions")) {
          if (init?.method === "POST") {
            versionWriteAttempted = true;
            return jsonResponse({ version: { version_number: 2 } });
          }
          return jsonResponse({
            versions: [{
              created_at: history[0].createdAt,
              files: history[0].files,
              id: "repo-publish-version-1",
              message: history[0].message,
              previous_version_id: null,
              source: history[0].source,
              version_number: 1,
            }],
          });
        }
        if (url.includes("/api/repos/repo-publish-printer/sync-status")) {
          return jsonResponse({ latestVersion: { version_number: 1 }, printer, updateAvailable: false });
        }
        if (url.includes("/api/repos/repo-publish-printer/sync-tokens")) return jsonResponse({ tokens: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await screen.findByText("Configuration Files");
    expect(screen.queryByRole("dialog", { name: /^Publish / })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish to Shared Configs" }));
    expect(screen.getByRole("dialog", { name: /^Publish / })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use package" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create package" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search packages" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByText("Applied configuration", { selector: "strong" }));
    const candidateRegion = await screen.findByRole("region", {
      name: "Applied publication candidate version 1",
    });
    expect(within(candidateRegion).getByText(/Applied version 1/)).toBeInTheDocument();
    await userEvent.click(within(candidateRegion).getByText("printer.cfg", { selector: "strong" }));
    const candidateSource = within(candidateRegion).getByLabelText("Applied candidate source for printer.cfg");
    expect(candidateSource).toHaveTextContent("APPLIED_CANDIDATE");
    expect(candidateSource).not.toHaveTextContent("PRIVATE_EDITOR_DRAFT");
    await userEvent.click(screen.getByText("Listing details", { selector: "strong" }));
    fireEvent.change(screen.getByLabelText("Listing title"), { target: { value: "Workspace share test" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A reviewed public test configuration." } });
    expect(screen.getByRole("button", { name: "Remove printer model Workspace printer" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove hardware Klipper" }));
    const hardwareInput = screen.getByRole("combobox", { name: "Hardware" });
    await userEvent.type(hardwareInput, "core");
    await userEvent.click(screen.getByRole("option", { name: "CoreXY" }));
    expect(screen.getByRole("button", { name: "Remove hardware CoreXY" })).toBeInTheDocument();
    await userEvent.type(hardwareInput, "klip");
    await userEvent.click(screen.getByRole("option", { name: "Klipper" }));
    expect(screen.getByRole("button", { name: "Remove hardware Klipper" })).toBeInTheDocument();
    await userEvent.type(hardwareInput, "bea{Enter}");
    expect(screen.getByRole("button", { name: "Remove hardware Beacon" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove hardware Beacon" }));
    expect(screen.queryByRole("button", { name: "Remove hardware Beacon" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove search tags imported" }));
    const tagInput = screen.getByRole("combobox", { name: "Search tags" });
    await userEvent.type(tagInput, "reviewed{Enter}");
    expect(screen.getByRole("button", { name: "Remove search tags reviewed" })).toBeInTheDocument();
    const publishButton = within(screen.getByRole("dialog", { name: /^Publish / })).getByRole("button", { name: "Publish to Shared Configs" });
    expect(publishButton).toBeEnabled();
    await userEvent.click(publishButton);

    const confirmation = await screen.findByRole("group", {
      name: "Confirm public publication of Workspace share test",
    });
    expect(within(confirmation).getByText(/available without signing in/)).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Publish publicly" }));

    await waitFor(() => expect(publishedPackageId).toBe(savedPrivatePackageId));
    expect(publishedPackageId).toBe("printer-publish-printer-workspace");
    expect(publishedPrinterId).toBe("publish-printer");
    expect(publishedRepositoryId).toBe("repo-publish-printer");
    expect(publishedExpectedVersionId).toBe("repo-publish-version-1");
    expect(savedPrivatePackage).toMatchObject({
      files: [{ content: workspaceFile.content, path: workspaceFile.path }],
      variables: [{ name: "mcu_serial" }],
    });
    expect(getAccountStored<Array<{ files: Array<{ content: string }>; id: string }>>(
      "privatePackages",
      [],
    )).toContainEqual(expect.objectContaining({
      files: [expect.objectContaining({ content: workspaceFile.content })],
      id: "printer-publish-printer-workspace",
    }));
    expect(versionWriteAttempted).toBe(false);
    expect(await screen.findByRole("button", { name: "Copy public package link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View public listing" })).toHaveAttribute(
      "href",
      "http://localhost:3000/packages/workspace-share-0123456789abcdef",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Republish applied version" })).toBeEnabled();
    });
    expect(consoleError.mock.calls.some((args) => args.some((value) => (
      String(value).includes("Cannot update a component")
    )))).toBe(false);
  }, 10_000);

  it("keeps publication disabled for null or blocked candidates and lets the owner refresh", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const draftFile = {
      content: "# PRIVATE_DRAFT\n[printer]\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const printer = {
      ...workspaceTestPrinter("candidate-refresh-printer"),
      repositoryId: "repo-candidate-refresh",
      workspaceDraftFiles: [draftFile],
      workspaceFilePath: draftFile.path,
    };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", [draftFile]);
    setAccountStored("workspaceFilePath", draftFile.path);
    setAccountStored("workspaceContent", draftFile.content);
    let candidateAvailable = false;
    let publishAttempts = 0;
    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith(`/api/printers/${printer.id}/publication-candidate`)) {
        return jsonResponse({
          candidate: candidateAvailable ? {
            appliedAt: "2026-08-04T01:00:00.000Z",
            files: [{ ...draftFile, content: "# APPLIED_AFTER_REFRESH\ntoken: applied-secret-value\n" }],
            repositoryId: printer.repositoryId,
            versionId: "candidate-after-refresh",
            versionNumber: 1,
          } : null,
        });
      }
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.includes("/api/public-packages") && init?.method === "POST") {
        publishAttempts += 1;
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/sync-status")) return jsonResponse({ printer, updateAvailable: false });
      if (url.includes("/sync-tokens")) return jsonResponse({ tokens: [] });
      if (url.includes("/versions")) return jsonResponse({ versions: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await screen.findByText("Configuration Files");
    await userEvent.click(screen.getByRole("button", { name: "Publish to Shared Configs" }));
    expect(await screen.findByText("No applied candidate")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: /^Publish / })).getByRole("button", { name: "Publish to Shared Configs" })).toBeDisabled();
    expect(publishAttempts).toBe(0);

    candidateAvailable = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(await screen.findByText("Applied configuration", { selector: "strong" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: /^Publish / })).getByText("printer.cfg", { selector: "strong" }));
    expect(screen.getByLabelText("Applied candidate source for printer.cfg")).toHaveTextContent("APPLIED_AFTER_REFRESH");
    expect(await screen.findByText(/looks like a credential or token/i)).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: /^Publish / })).getByRole("button", { name: "Publish to Shared Configs" })).toBeDisabled();
    expect(publishAttempts).toBe(0);
  });

  it("refreshes and requires another review when the applied candidate changes during republish", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    let candidateVersion = 2;
    const appliedFiles = () => [{
      content: `# NEWLY_APPLIED_CANDIDATE_V${candidateVersion}\n[printer]\n`,
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    const privatePackage = {
      ...packages[0],
      files: [{ content: "# Existing reviewed public configuration\n", path: "printer.cfg", public: false, role: "printer" }],
      id: "existing-workspace-package",
      tags: ["private"],
      title: "Existing workspace listing",
    };
    const publicPackage = {
      ...privatePackage,
      id: "existing-workspace-listing-0123456789abcdef",
      publicSlug: "existing-workspace-listing-0123456789abcdef",
      sourcePackageId: privatePackage.id,
      tags: ["public"],
      tracksAppliedConfiguration: true,
    };
    const printer = {
      ...workspaceTestPrinter("update-printer"),
      appliedVersionId: 2,
      latestVersionId: 2,
      packageIds: [privatePackage.id],
      repositoryId: "repo-update-printer",
      workspaceDraftFiles: privatePackage.files,
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("privatePackages", [privatePackage]);
    setAccountStored("workspaceDraftFiles", privatePackage.files);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", privatePackage.files[0].content);
    setAccountStored("workspaceDrafts", { "printer.cfg": privatePackage.files[0].content });
    let publishedPackageId = "";
    const publishAttempts: string[] = [];
    let republished = false;
    let candidateRequestCount = 0;
    let statusRequestCount = 0;
    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.endsWith(`/api/printers/${printer.id}/publication-candidate`)) {
        candidateRequestCount += 1;
        return jsonResponse({
          candidate: {
            appliedAt: "2026-07-27T01:00:00.000Z",
            files: appliedFiles(),
            repositoryId: printer.repositoryId,
            versionId: `version-newly-applied-${candidateVersion}`,
            versionNumber: candidateVersion,
          },
        });
      }
      if (url.includes("/api/private-packages") && init?.method === "POST") return jsonResponse({ savedAt: "2026-07-27T00:00:00.000Z" });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [privatePackage] });
      if (url.endsWith(`/api/public-packages/${publicPackage.publicSlug}/status`)) {
        statusRequestCount += 1;
        return jsonResponse({
          status: {
            approvedVersionId: republished ? `version-newly-applied-${candidateVersion}` : "version-approved",
            currentAppliedVersionId: `version-newly-applied-${candidateVersion}`,
            hasUnpublishedAppliedVersion: !republished,
            linked: true,
          },
        });
      }
      if (url.includes("/api/public-packages") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { expectedAppliedVersionId: string; packageId: string };
        publishAttempts.push(body.expectedAppliedVersionId);
        if (publishAttempts.length === 1) {
          candidateVersion = 3;
          return jsonResponse({ error: "Applied configuration changed; review the new version before publishing" }, 409);
        }
        publishedPackageId = body.packageId;
        republished = true;
        return jsonResponse({
          package: publicPackage,
          shareUrl: `https://klippee.xyz/packages/${publicPackage.publicSlug}`,
        });
      }
      if (url.includes("/api/packages")) return jsonResponse({ packages: [publicPackage] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/repos/repo-update-printer/versions")) {
        return jsonResponse({
          versions: [{
            created_at: "2026-07-27T00:00:00.000Z",
            files: privatePackage.files,
            id: "repo-update-version-1",
            message: "Existing desired configuration",
            previous_version_id: null,
            source: "web-editor",
            version_number: 1,
          }],
        });
      }
      if (url.includes("/api/repos/repo-update-printer/sync-status")) {
        return jsonResponse({ latestVersion: { version_number: 1 }, printer, updateAvailable: false });
      }
      if (url.includes("/api/repos/repo-update-printer/sync-tokens")) return jsonResponse({ tokens: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await screen.findByText("Configuration Files");
    await userEvent.click(screen.getByRole("button", { name: "Publish to Shared Configs" }));
    expect(await screen.findByText("Applied update ready to publish")).toBeInTheDocument();
    expect(screen.getByText("Only printer-applied configurations are published. Draft edits stay private.")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Applied configuration", { selector: "strong" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: /^Publish / })).getByText("printer.cfg", { selector: "strong" }));
    expect(await screen.findByLabelText("Applied candidate source for printer.cfg")).toHaveTextContent(
      "NEWLY_APPLIED_CANDIDATE_V2",
    );
    expect(screen.getByRole("link", { name: "View public listing" })).toHaveAttribute("href", `http://localhost:3000/packages/${publicPackage.publicSlug}`);
    const republishButton = screen.getByRole("button", { name: "Approve and republish" });
    await waitFor(() => expect(republishButton).toBeEnabled());
    await userEvent.click(republishButton);
    await waitFor(() => {
      expect(screen.getByText(/applied configuration changed; review the refreshed version/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Applied candidate source for printer.cfg")).toHaveTextContent(
        "NEWLY_APPLIED_CANDIDATE_V3",
      );
    });
    expect(publishAttempts).toEqual(["version-newly-applied-2"]);
    expect(publishedPackageId).toBe("");
    await waitFor(() => expect(republishButton).toBeEnabled());
    await userEvent.click(republishButton);
    await waitFor(() => expect(publishedPackageId).toBe(privatePackage.id));
    expect(publishAttempts).toEqual(["version-newly-applied-2", "version-newly-applied-3"]);
    await waitFor(() => expect(candidateRequestCount).toBeGreaterThan(1));
    await waitFor(() => expect(statusRequestCount).toBeGreaterThan(1));
    await waitFor(() => {
      expect(screen.getByText("Public listing is up to date")).toBeInTheDocument();
    });
  });

  it("does not leak registry package variables into the current printer workspace", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    stubWorkspacePrinterApi();

    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));
    await userEvent.click(await screen.findByRole("button", { name: /Klipper Cartesian Starter/ }));
    await userEvent.click(screen.getByRole("button", { name: "Configure for a printer" }));

    expect(await screen.findByRole("textbox", { name: /Edit/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace tools")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("MCU serial path")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Maximum XY velocity")).not.toBeInTheDocument();
  });

  it("hydrates a catalog summary package's file contents on demand", async () => {
    const summary = {
      description: "Public package",
      files: [{ content: "", path: "printer.cfg", public: true, role: "printer" }],
      hardware: ["cartesian"],
      id: "pub-1",
      name: "pub-1",
      printer: "Bench printer",
      tags: ["public"],
      title: "Public One",
      variables: [],
      version: "1",
      warnings: [],
    };
    const full = { ...summary, files: [{ ...summary.files[0], content: "[printer]\n" }] };
    const requested: string[] = [];

    stubApiRoutes((url) => {
        requested.push(url);
        if (url.includes("/api/auth/me")) return jsonResponse({ user: null });
        if (/\/api\/packages\/[^/?]+$/.test(url)) return jsonResponse({ package: full });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [summary] });
        return jsonResponse({});
      });

    render(<App />);

    // The catalog summary has no file contents; selecting it triggers a hydration
    // fetch for the full package by id.
    await waitFor(() => {
      expect(requested.some((url) => /\/api\/packages\/pub-1$/.test(url))).toBe(true);
    });
  });

  it("hydrates a private package summary's file contents on demand", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const summary = {
      description: "Private package",
      files: [{ content: "", path: "printer.cfg", public: false, role: "printer" }],
      hardware: ["cartesian"],
      id: "private-1",
      name: "private-1",
      printer: "Bench printer",
      tags: ["private"],
      title: "Private One",
      variables: [],
      version: "1",
      warnings: [],
    };
    const full = { ...summary, files: [{ ...summary.files[0], content: "[printer]\n" }] };
    const requested: string[] = [];

    stubApiRoutes((url) => {
        requested.push(url);
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (/\/api\/private-packages\/[^/?]+$/.test(url)) return jsonResponse({ package: full });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [summary] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/printers")) return jsonResponse({ printers: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await waitFor(() => {
      expect(requested.some((url) => /\/api\/private-packages\/private-1$/.test(url))).toBe(true);
    });
  });
});
