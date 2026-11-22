import { act, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { repositoryFilesRevision } from "./repositoryRevision";
import {
  fetchState,
  getAccountStored,
  jsonResponse,
  setAccountStored,
  stubApiRoutes,
  workspaceTestPrinter,
} from "./test/appTestUtils";

describe("App cloud sync and drafts", () => {
  it("loads cloud app-state after sign-in", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const requested: string[] = [];

    stubApiRoutes((url) => {
        requested.push(url);
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.includes("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/printers")) return jsonResponse({ printers: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/api/app-state"))).toBe(true);
    });
  });

  it("keeps the locally selected printer when cloud app-state still has the previous selection", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const firstPrinter = {
      ...workspaceTestPrinter("printer-first"),
      name: "First printer",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    const secondPrinter = {
      ...workspaceTestPrinter("printer-second"),
      name: "Second printer",
      updatedAt: "2026-07-25T00:00:00.000Z",
    };
    setAccountStored("printers", [firstPrinter, secondPrinter]);
    setAccountStored("selectedPrinterId", secondPrinter.id);

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) {
          return jsonResponse({
            state: {
              history: [],
              printer: {
                appliedVersionId: 0,
                lastSeen: "never",
                latestVersionId: 0,
                name: firstPrinter.name,
              },
              printers: [firstPrinter, secondPrinter],
              repositoryId: null,
              selectedFilePath: "printer.cfg",
              selectedPackageId: "",
              selectedPrinterId: firstPrinter.id,
              values: {},
              workspaceContent: "",
              workspaceFilePath: "printer.cfg",
            },
            updatedAt: "2026-07-24T00:00:00.000Z",
          });
        }
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: [firstPrinter, secondPrinter] });
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await waitFor(() => {
      expect(getAccountStored("selectedPrinterId", "")).toBe(secondPrinter.id);
    });
    expect(await screen.findByText("Second printer")).toBeInTheDocument();
  });

  it("keeps a returning account's local draft and local-only values over stale cloud state", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const secretSentinel = "local-only-secret-sentinel";
    const baseContent = "[printer]\nmax_velocity: 300\n";
    const localDraft = "[printer]\nmax_velocity: 425\n";
    const history = [{
      createdAt: "2026-07-24T00:00:00.000Z",
      files: [{ content: baseContent, path: "printer.cfg", public: false, role: "printer" }],
      id: 1,
      message: "Local baseline",
      previousId: null,
      source: "manual",
    }];
    const localPrinter = {
      ...workspaceTestPrinter("printer-private-values"),
      history,
      variableValues: { api_token: secretSentinel, max_accel: "2500" },
      workspaceDrafts: { "printer.cfg": localDraft },
      workspaceFilePath: "printer.cfg",
    };
    const cloudPrinter: Partial<typeof localPrinter> = {
      ...localPrinter,
      variableValues: { max_accel: "2750" },
    };
    delete cloudPrinter.history;
    delete cloudPrinter.workspaceDrafts;
    delete cloudPrinter.workspaceFilePath;

    setAccountStored("history", history);
    setAccountStored("printers", [localPrinter]);
    setAccountStored("selectedPrinterId", localPrinter.id);
    setAccountStored("values", localPrinter.variableValues);
    setAccountStored("workspaceContent", localDraft);
    setAccountStored("workspaceDrafts", { "printer.cfg": localDraft });
    setAccountStored("workspaceFilePath", "printer.cfg");

    const appStateWrites: string[] = [];
    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state") && init?.method === "PUT") {
        appStateWrites.push(String(init.body));
        return jsonResponse({
          code: "app_state_conflict",
          error: "Cloud state changed; reload it before saving again",
        }, 409);
      }
      if (url.endsWith("/api/app-state")) {
        return jsonResponse({
          state: {
            history: [],
            printer: {
              appliedVersionId: 0,
              lastSeen: "never",
              latestVersionId: 0,
              name: localPrinter.name,
            },
            printers: [{ ...cloudPrinter }],
            repositoryId: null,
            selectedFilePath: "printer.cfg",
            selectedPackageId: "",
            selectedPrinterId: localPrinter.id,
            workspaceContent: "[printer]\nmax_velocity: 100\n",
            workspaceFilePath: "printer.cfg",
          },
          revision: "b".repeat(64),
          updatedAt: "2026-07-23T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [cloudPrinter] });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await waitFor(() => {
      const [storedPrinter] = getAccountStored<Array<typeof localPrinter>>("printers", []);
      expect(storedPrinter.variableValues).toEqual({
        api_token: secretSentinel,
        max_accel: "2750",
      });
    });
    expect(getAccountStored("workspaceContent", "")).toBe(localDraft);
    expect(getAccountStored("workspaceDrafts", {})).toEqual({ "printer.cfg": localDraft });

    await waitFor(() => expect(appStateWrites.length).toBeGreaterThan(0), { timeout: 4_000 });
    expect(appStateWrites.join("\n")).not.toContain(secretSentinel);
    const attemptedSave = JSON.parse(appStateWrites.at(-1) ?? "{}");
    expect(attemptedSave.expectedRevision).toBeNull();
    const savedState = attemptedSave.state;
    expect(savedState).not.toHaveProperty("values");
    expect(savedState.printers[0]).not.toHaveProperty("variableValues");
    expect(await screen.findByText(/Cloud state changed; reload it before saving again/)).toBeInTheDocument();
  }, 10_000);

  it("keeps a non-selected printer's local draft over stale cloud state", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const localDraft = "[printer]\nmax_velocity: 425\n";
    const draftFile = { content: localDraft, path: "printer.cfg", public: false, role: "printer" };
    const draftPrinter = {
      ...workspaceTestPrinter("printer-with-local-draft"),
      name: "Printer with local draft",
      workspaceDraftFiles: [draftFile],
      workspaceDrafts: { "printer.cfg": localDraft },
      workspaceFilePath: "printer.cfg",
    };
    const selectedPrinter = {
      ...workspaceTestPrinter("selected-clean-printer"),
      name: "Selected clean printer",
    };
    const cloudDraftPrinter: Partial<typeof draftPrinter> = { ...draftPrinter };
    delete cloudDraftPrinter.workspaceDraftFiles;
    delete cloudDraftPrinter.workspaceDrafts;
    delete cloudDraftPrinter.workspaceFilePath;

    setAccountStored("printers", [draftPrinter, selectedPrinter]);
    setAccountStored("selectedPrinterId", selectedPrinter.id);
    setAccountStored("workspaceContent", "");
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "printer.cfg");

    stubApiRoutes((url, init) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state") && init?.method === "PUT") {
        return jsonResponse({ ok: true, updatedAt: "2026-07-25T00:00:00.000Z" });
      }
      if (url.endsWith("/api/app-state")) {
        return jsonResponse({
          state: {
            history: [],
            printer: {
              appliedVersionId: 0,
              lastSeen: "never",
              latestVersionId: 0,
              name: selectedPrinter.name,
            },
            printers: [cloudDraftPrinter, selectedPrinter],
            repositoryId: null,
            selectedFilePath: "printer.cfg",
            selectedPackageId: "",
            selectedPrinterId: selectedPrinter.id,
            workspaceContent: "[printer]\nmax_velocity: 100\n",
            workspaceFilePath: "printer.cfg",
          },
          updatedAt: "2026-07-23T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/printers")) {
        return jsonResponse({ printers: [cloudDraftPrinter, selectedPrinter] });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await waitFor(() => {
      const storedPrinters = getAccountStored<Array<typeof draftPrinter>>("printers", []);
      const storedDraftPrinter = storedPrinters.find((printer) => printer.id === draftPrinter.id);
      expect(storedDraftPrinter?.workspaceDraftFiles).toEqual([draftFile]);
      expect(storedDraftPrinter?.workspaceDrafts).toEqual({ "printer.cfg": localDraft });
    });
    expect(getAccountStored("selectedPrinterId", "")).toBe(selectedPrinter.id);
    expect(getAccountStored("workspaceDrafts", {})).toEqual({});
  });

  it("does not render cached config files while the latest synced workspace is loading", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const staleFiles = [
      { content: "[printer]\n", path: "stale-printer.cfg", public: false, role: "printer" },
      { content: "[include stale-printer.cfg]\n", path: "stale-macros.cfg", public: false, role: "macro" },
    ];
    const staleHistory = [{
      createdAt: "2026-07-01T00:00:00.000Z",
      files: staleFiles,
      id: 1,
      message: "Cached workspace",
      previousId: null,
      source: "manual",
    }];
    const printer = {
      appliedVersionId: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      description: "",
      id: "printer-1",
      latestVersionId: 1,
      make: "",
      model: "",
      name: "Current printer",
      packageIds: [],
      repositoryId: "repo-1",
      source: "manual",
      updatedAt: "2026-07-22T00:00:00.000Z",
      variableValues: {},
      workspaceFilePath: "stale-printer.cfg",
    };
    setAccountStored("history", staleHistory);
    setAccountStored("printers", [{ ...printer, history: staleHistory }]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceFilePath", "stale-printer.cfg");
    setAccountStored("workspaceContent", "[printer]\n");

    let versionsRequested = false;
    let resolveVersions!: (response: Response) => void;
    const versionsResponse = new Promise<Response>((resolve) => {
      resolveVersions = resolve;
    });

    stubApiRoutes((url) => {
        if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
        if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
        if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
        if (url.split("?")[0].endsWith("/api/repos/repo-1/versions")) {
          versionsRequested = true;
          return versionsResponse;
        }
        if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
        if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
        if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
        return jsonResponse({});
      });

    render(<App />);

    await waitFor(() => expect(versionsRequested).toBe(true));
    expect(screen.getByRole("heading", { name: "Loading your workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Configuration Files")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-printer.cfg")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-macros.cfg")).not.toBeInTheDocument();

    act(() => {
      resolveVersions(jsonResponse({
        versions: [{
          created_at: "2026-07-22T01:00:00.000Z",
          files: [{ content: "[printer]\nmax_velocity: 400\n", path: "current.cfg", public: false, role: "printer" }],
          id: "version-2",
          message: "Latest printer sync",
          previous_version_id: null,
          source: "capture",
          version_number: 2,
        }],
      }));
    });

    expect(await screen.findByRole("heading", { name: "current.cfg" })).toBeInTheDocument();
    expect(screen.queryByText("stale-printer.cfg")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-macros.cfg")).not.toBeInTheDocument();
  });

  it("reopens the current desired draft instead of applying a stale local hardcoded overlay", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const beaconPath = "/dev/serial/by-id/usb-Beacon_Beacon_RevH_123456-if00";
    const immutableFile = {
      content: `[beacon]\nserial: ${beaconPath}\n`,
      path: "beacon.cfg",
      public: false,
      role: "include",
    };
    const desiredFile = {
      ...immutableFile,
      content: "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    };
    const history = [{
      createdAt: "2026-08-05T00:00:00.000Z",
      files: [immutableFile],
      id: 9,
      message: "Captured printer configuration",
      previousId: null,
      source: "capture",
    }];
    const printer = {
      ...workspaceTestPrinter("printer-pending-variable"),
      appliedVersionId: 9,
      history,
      latestVersionId: 9,
      repositoryId: "repo-pending-variable",
      variableValues: { beacon_serial: beaconPath },
      workspaceBaseRevision: await repositoryFilesRevision([immutableFile]),
      workspaceFilePath: "beacon.cfg",
    };
    const topLevelDrafts = { "beacon.cfg": immutableFile.content };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    // The active editor is persisted at account scope. The printer snapshot can
    // legitimately lag behind it until a switch, so hydration must read this
    // live draft instead of relying only on PrinterRecord.workspaceDrafts.
    setAccountStored("workspaceDrafts", topLevelDrafts);
    setAccountStored("workspaceFilePath", "beacon.cfg");
    setAccountStored("workspaceContent", immutableFile.content);

    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-pending-variable/versions")) {
        return jsonResponse({
          desired: {
            createdAt: "2026-08-06T00:00:00.000Z",
            files: [desiredFile],
            pending: true,
            revision: "sha256:pending-variable",
            source: "pending",
            versionId: null,
            versionNumber: 10,
          },
          versions: [{
            created_at: history[0].createdAt,
            files: [immutableFile],
            id: "version-9",
            message: history[0].message,
            previous_version_id: null,
            source: history[0].source,
            version_number: 9,
          }],
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Edit beacon.cfg" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveTextContent("${KLIPPEE:beacon_serial}");
    });
    expect(document.querySelector(".cm-content")).not.toHaveTextContent(beaconPath);
    expect(getAccountStored("workspaceDraftFiles", [])).toEqual([desiredFile]);
    expect(getAccountStored("workspaceDrafts", {})).toEqual({});
    const [storedPrinter] = getAccountStored<Array<typeof printer & { workspaceDrafts?: Record<string, string> }>>(
      "printers",
      [],
    );
    expect(storedPrinter.workspaceBaseRevision).toBe("sha256:pending-variable");
    expect(storedPrinter.workspaceDrafts).toEqual({});
  });

  it("preserves a divergent active draft stored only in account workspace state", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const immutableFile = {
      content: "[printer]\nmax_velocity: 250\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const desiredFile = {
      ...immutableFile,
      content: "[printer]\nmax_velocity: 300\n",
    };
    const desiredRevision = await repositoryFilesRevision([desiredFile]);
    const locallyEditedContent = `${desiredFile.content}# local edit still in progress\n`;
    const history = [{
      createdAt: "2026-08-05T00:00:00.000Z",
      files: [immutableFile],
      id: 4,
      message: "Captured configuration",
      previousId: null,
      source: "capture",
    }];
    const printer = {
      ...workspaceTestPrinter("printer-live-account-draft"),
      history,
      latestVersionId: 4,
      repositoryId: "repo-live-account-draft",
      workspaceBaseRevision: desiredRevision,
      workspaceFilePath: "printer.cfg",
    };
    const topLevelDrafts = { "printer.cfg": locallyEditedContent };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", topLevelDrafts);
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", locallyEditedContent);

    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-live-account-draft/versions")) {
        return jsonResponse({
          desired: {
            createdAt: "2026-08-06T00:00:00.000Z",
            files: [desiredFile],
            pending: true,
            revision: desiredRevision,
            source: "pending",
            versionId: null,
            versionNumber: 5,
          },
          versions: [{
            created_at: history[0].createdAt,
            files: [immutableFile],
            id: "version-4",
            message: history[0].message,
            previous_version_id: null,
            source: history[0].source,
            version_number: 4,
          }],
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Edit printer.cfg" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveTextContent("local edit still in progress");
      expect(getAccountStored("workspaceDrafts", {})).toEqual(topLevelDrafts);
    });
    expect(getAccountStored("workspaceDraftFiles", [])).toEqual([desiredFile]);
  });

  it("opens a desired draft before the printer has created its first immutable version", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const desiredFile = {
      content: "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
      path: "beacon.cfg",
      public: false,
      role: "include",
    };
    const printer = {
      ...workspaceTestPrinter("printer-first-draft"),
      appliedVersionId: 0,
      history: [],
      latestVersionId: 0,
      repositoryId: "repo-first-draft",
      variableValues: { beacon_serial: "/dev/serial/by-id/first-draft" },
      workspaceFilePath: "beacon.cfg",
    };
    setAccountStored("history", []);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "beacon.cfg");
    setAccountStored("workspaceContent", "");

    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-first-draft/versions")) {
        return jsonResponse({
          desired: {
            createdAt: "2026-08-06T01:00:00.000Z",
            files: [desiredFile],
            pending: true,
            revision: "sha256:first-draft",
            source: "pending",
            versionId: null,
            versionNumber: 1,
          },
          versions: [],
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Edit beacon.cfg" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveTextContent("${KLIPPEE:beacon_serial}");
    });
    expect(getAccountStored("workspaceDraftFiles", [])).toEqual([desiredFile]);
    expect(getAccountStored("history", ["stale"])).toEqual([]);
  });

  it("does not overwrite an editor change made while repository history is loading", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const desiredFile = {
      content: "[printer]\nmax_velocity: 300\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    const historyPayload = {
      desired: {
        createdAt: "2026-08-06T01:00:00.000Z",
        files: [desiredFile],
        pending: true,
        revision: "sha256:in-flight-draft",
        source: "pending",
        versionId: null,
        versionNumber: 1,
      },
      versions: [],
    };
    const printer = {
      ...workspaceTestPrinter("printer-in-flight-edit"),
      repositoryId: "repo-in-flight-edit",
      workspaceFilePath: "printer.cfg",
    };
    setAccountStored("history", []);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "printer.cfg");
    setAccountStored("workspaceContent", "");

    let versionsRequestCount = 0;
    let resolveReload: ((response: Response) => void) | null = null;
    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-in-flight-edit/versions")) {
        versionsRequestCount += 1;
        if (versionsRequestCount === 1) {
          return jsonResponse(historyPayload);
        }
        return new Promise<Response>((resolve) => {
          resolveReload = resolve;
        });
      }
      if (url.endsWith("/api/repos/repo-in-flight-edit/sync-status")) return jsonResponse({});
      if (url.endsWith("/api/repos/repo-in-flight-edit/sync-tokens")) return jsonResponse({ tokens: [] });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await screen.findByRole("textbox", { name: "Edit printer.cfg" });
    await userEvent.click(screen.getByRole("link", { name: "Printers" }));
    const checkCapture = await screen.findByRole("button", { name: /Check capture/ });
    act(() => checkCapture.click());
    await waitFor(() => expect(versionsRequestCount).toBe(2));

    await userEvent.click(screen.getByRole("link", { name: "Klipper Workspace" }));
    const editor = await screen.findByRole("textbox", { name: "Edit printer.cfg" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    const localEdit = "# edit made while refresh was pending\n";
    act(() => {
      editorView!.dispatch({
        changes: { from: editorView!.state.doc.length, insert: localEdit },
      });
    });
    await waitFor(() => {
      expect(getAccountStored<Record<string, string>>("workspaceDrafts", {})["printer.cfg"])
        .toContain("refresh was pending");
    });

    await act(async () => {
      resolveReload?.(jsonResponse(historyPayload));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(EditorView.findFromDOM(editor)?.state.doc.toString()).toContain(localEdit.trim());
      expect(getAccountStored<Record<string, string>>("workspaceDrafts", {})["printer.cfg"])
        .toContain("refresh was pending");
    });
  });

  it("creates an editable staged printer.cfg when the linked repository is truly empty", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = {
      ...workspaceTestPrinter("printer-empty-repository"),
      repositoryId: "repo-empty",
      workspaceFilePath: "old-printer.cfg",
    };
    setAccountStored("history", []);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "old-printer.cfg");
    setAccountStored("workspaceContent", "# content from a different repository\n");

    const pendingWrites: Array<{
      baseRevision?: string | null;
      files?: Array<{ content: string; path: string; public: boolean; role: string }>;
    }> = [];
    stubApiRoutes((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-empty/versions")) {
        return jsonResponse({ desired: null, versions: [] });
      }
      if (url.endsWith("/api/repos/repo-empty/pending") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as {
          baseRevision?: string | null;
          files?: typeof pendingWrites[number]["files"];
        };
        pendingWrites.push(body);
        return jsonResponse({
          desired: {
            createdAt: "2026-08-06T02:00:00.000Z",
            revision: "sha256:first-empty-repo-draft",
          },
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    const editor = await screen.findByRole("textbox", { name: "Edit printer.cfg" });
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).not.toHaveTextContent("different repository");
      expect(getAccountStored("workspaceFilePath", "")).toBe("printer.cfg");
      expect(getAccountStored("workspaceContent", "stale")).toBe("");
      expect(getAccountStored("workspaceDraftFiles", null)).toEqual([
        { content: "", path: "printer.cfg", public: false, role: "printer" },
      ]);
    });
    const [storedPrinter] = getAccountStored<Array<typeof printer>>("printers", []);
    expect(storedPrinter.workspaceFilePath).toBe("printer.cfg");
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    const firstConfig = "[printer]\nkinematics: corexy\nmax_velocity: 300\n";
    act(() => {
      editorView!.dispatch({ changes: { from: 0, insert: firstConfig } });
    });
    await waitFor(() => {
      expect(pendingWrites.at(-1)?.files).toEqual([
        { content: firstConfig, path: "printer.cfg", public: false, role: "printer" },
      ]);
    }, { timeout: 4_000 });
  });

  it("clears an equivalent cached desired draft after the printer applies it", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const appliedFile = {
      content: "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
      path: "beacon.cfg",
      public: false,
      role: "include",
    };
    const appliedRevision = await repositoryFilesRevision([appliedFile]);
    const history = [{
      createdAt: "2026-08-06T00:00:00.000Z",
      files: [appliedFile],
      id: 10,
      message: "Applied printer configuration",
      previousId: 9,
      source: "printer-apply",
    }];
    const printer = {
      ...workspaceTestPrinter("printer-applied-variable"),
      appliedVersionId: 10,
      history,
      latestVersionId: 10,
      repositoryId: "repo-applied-variable",
      variableValues: { beacon_serial: "/dev/serial/by-id/usb-Beacon_RevH_123456-if00" },
      workspaceBaseRevision: appliedRevision,
      workspaceDraftFiles: [appliedFile],
      workspaceDrafts: { "beacon.cfg": appliedFile.content },
      workspaceFilePath: "beacon.cfg",
    };
    setAccountStored("history", history);
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    setAccountStored("workspaceDraftFiles", null);
    setAccountStored("workspaceDrafts", {});
    setAccountStored("workspaceFilePath", "beacon.cfg");
    setAccountStored("workspaceContent", appliedFile.content);

    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
      if (url.split("?")[0].endsWith("/api/repos/repo-applied-variable/versions")) {
        return jsonResponse({
          desired: {
            createdAt: history[0].createdAt,
            files: [appliedFile],
            pending: false,
            revision: appliedRevision,
            source: history[0].source,
            versionId: "version-10",
            versionNumber: 10,
          },
          versions: [{
            created_at: history[0].createdAt,
            files: [appliedFile],
            id: "version-10",
            message: history[0].message,
            previous_version_id: "version-9",
            source: history[0].source,
            version_number: 10,
          }],
        });
      }
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Edit beacon.cfg" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveTextContent("${KLIPPEE:beacon_serial}");
      expect(getAccountStored("workspaceDraftFiles", [appliedFile])).toBeNull();
      expect(getAccountStored("workspaceDrafts", { stale: "value" })).toEqual({});
    });
    const [storedPrinter] = getAccountStored<Array<typeof printer>>("printers", []);
    expect(storedPrinter.workspaceDraftFiles).toBeNull();
    expect(storedPrinter.workspaceDrafts).toEqual({});
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });
});
