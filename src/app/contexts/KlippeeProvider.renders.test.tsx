import { act, waitFor } from "@testing-library/react";
import { renderWithUi } from "../../test/uiTestUtils";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { stubApiRoutes, TestQueryClientProvider } from "../../test/appTestUtils";
import type { AuthSession } from "../hooks/useAuthSession";
import { AccountStorageProvider } from "./AccountStorageContext";
import { KlippeeProvider } from "./KlippeeProvider";
import { usePackageContext } from "./usePackageContext";
import { usePrinterContext } from "./usePrinterContext";
import { useRepositoryContext } from "./useRepositoryContext";
import { useWorkspaceContext, type WorkspaceContextValue } from "./useWorkspaceContext";

function anonymousAuthSession(): AuthSession {
  return {
    authChecked: true,
    authStatus: "Not signed in",
    authUser: null,
    cloudStatus: "Sign in to save to cloud",
    loginOpen: false,
    logout: async () => true,
    setCloudStatus: () => {},
    setLoginOpen: () => {},
  };
}

// Render-count probes: each consumer re-renders only when its own context
// value changes identity, because KlippeeProvider memoizes every value and
// useKlippeeApp hands out identity-stable handlers. Counting happens in a
// dependency-less effect, which runs exactly once per committed render of
// the probe.
const renderCounts = { package: 0, printer: 0, repository: 0, workspace: 0 };
let workspaceApi: WorkspaceContextValue | null = null;
let lastCatalogStatus = "";

function PrinterProbe() {
  usePrinterContext();
  useEffect(() => {
    renderCounts.printer += 1;
  });
  return null;
}

function RepositoryProbe() {
  useRepositoryContext();
  useEffect(() => {
    renderCounts.repository += 1;
  });
  return null;
}

function PackageProbe() {
  const context = usePackageContext();
  useEffect(() => {
    lastCatalogStatus = context.catalogStatus;
    renderCounts.package += 1;
  });
  return null;
}

function WorkspaceProbe() {
  const context = useWorkspaceContext();
  useEffect(() => {
    workspaceApi = context;
    renderCounts.workspace += 1;
  });
  return null;
}

describe("KlippeeProvider render isolation", () => {
  beforeEach(() => {
    localStorage.clear();
    renderCounts.package = 0;
    renderCounts.printer = 0;
    renderCounts.repository = 0;
    renderCounts.workspace = 0;
    workspaceApi = null;
  });

  it("re-renders only WorkspaceContext consumers on a workspace content change", async () => {
    stubApiRoutes();
    renderWithUi(
      <MemoryRouter>
        <AccountStorageProvider userId={null}>
          <TestQueryClientProvider>
            <KlippeeProvider authSession={anonymousAuthSession()}>
              <PrinterProbe />
              <RepositoryProbe />
              <PackageProbe />
              <WorkspaceProbe />
            </KlippeeProvider>
          </TestQueryClientProvider>
        </AccountStorageProvider>
      </MemoryRouter>,
    );

    // Let the debounced public-catalog load (250ms debounce + fetch) fully
    // settle so no in-flight async work can flush inside the keystroke act()
    // below and be mistaken for keystroke fallout. waitFor flushes React
    // update queues between polls, which a plain sleep inside act() does not.
    await waitFor(
      () => {
        expect(lastCatalogStatus).toMatch(/^(Loaded from API|Using bundled packages)$/);
      },
      { timeout: 5000 },
    );
    expect(workspaceApi).not.toBeNull();

    const printerRenders = renderCounts.printer;
    const repositoryRenders = renderCounts.repository;
    const packageRenders = renderCounts.package;
    const workspaceRenders = renderCounts.workspace;

    act(() => {
      workspaceApi?.updateWorkspaceContent("[printer]\nkinematics: corexy\n");
    });

    expect(renderCounts.workspace).toBeGreaterThan(workspaceRenders);
    expect(renderCounts.printer).toBe(printerRenders);
    expect(renderCounts.repository).toBe(repositoryRenders);
    expect(renderCounts.package).toBe(packageRenders);
  });
});
