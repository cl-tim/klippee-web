import {
  BookOpen,
  Cable,
  CheckCircle2,
  ExternalLink,
  FileSliders,
  FileSearch,
  Grid3X3,
  Heart,
  LayoutGrid,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Printer,
  X,
} from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ActionIcon, Alert, AppShell as MantineAppShell, Button, Group, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router";
import { primaryTabs, tabLabels, tabPaths } from "./app/constants";
import { AccountStorageProvider } from "./app/contexts/AccountStorageContext";
import { KlippeeProvider } from "./app/contexts/KlippeeProvider";
import { useAppShellContext } from "./app/contexts/useAppShellContext";
import { useAccountStorageStatus } from "./app/contexts/useAccountStorage";
import { usePackageContext } from "./app/contexts/usePackageContext";
import { useAuthSession } from "./app/hooks/useAuthSession";
import { AuthRequiredPanel, EmptyPanel } from "./components/common";
import { OrcaWorkspaceView } from "./features/workflows/OrcaWorkspaceView";
import {
  AuthPanel,
  PrinterDetailsModal,
  PrintersView,
  RegistryView,
  SlicerWorkspaceView as KlipperWorkspaceView,
} from "./features/workflows/WorkflowViews";
import { createAppQueryClient } from "./app/queryClient";
import { UiProvider } from "./app/UiProvider";
import { Separator } from "./components/ui/separator";
import { loadGlobalStored, saveGlobalStored } from "./storage";

const ParametricCadEditor = lazy(() => import("./features/cadEditors/ParametricCadEditor").then((module) => ({ default: module.ParametricCadEditor })));
const OpenScadView = lazy(() => import("./features/openscad/OpenScadView").then((module) => ({ default: module.OpenScadView })));
const ScadToBuild123dView = lazy(() => import("./features/scadConverter/ScadToBuild123dView").then((module) => ({ default: module.ScadToBuild123dView })));
const LogDiagnosticsView = lazy(() => import("./features/logDiagnostics/LogDiagnosticsView").then((module) => ({ default: module.LogDiagnosticsView })));
const PublicAssetView = lazy(() => import("./features/workflows/PublicAssetView").then((module) => ({ default: module.PublicAssetView })));

export function App() {
  return (
    <UiProvider><BrowserRouter>
      <ScrollToTop />
      <ResolvedSessionApp />
    </BrowserRouter></UiProvider>
  );
}

function ResolvedSessionApp() {
  const authSession = useAuthSession();
  if (!authSession.authChecked) {
    return (
      <main className="workbench">
        <EmptyPanel title="Loading Klippee" />
      </main>
    );
  }

  const identityKey = authSession.authUser?.id ?? "anonymous";
  return (
    <AccountStorageProvider key={identityKey} userId={authSession.authUser?.id ?? null}>
      <AppQueryProvider>
        <KlippeeProvider authSession={authSession}>
          <AppShell />
        </KlippeeProvider>
      </AppQueryProvider>
    </AccountStorageProvider>
  );
}

// Lives inside the identity-keyed AccountStorageProvider subtree on purpose:
// switching accounts remounts it, giving each signed-in identity a fresh query
// cache exactly like the pre-query-library hooks whose state also reset on the
// identity remount.
function AppQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createAppQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const main = document.getElementById("main-content");
    if (main) {
      main.scrollTop = 0;
      if (previousPath.current !== pathname) main.focus({ preventScroll: true });
    }
    previousPath.current = pathname;
  }, [pathname]);

  return null;
}

function AppShell() {
  const { activeTab } = useAppShellContext();
  const storageStatus = useAccountStorageStatus();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const [appNavigationExpanded, setAppNavigationExpanded] = useState(
    () => loadGlobalStored("appNavigationExpanded", true),
  );
  const [appNavigationPinned, setAppNavigationPinned] = useState(
    () => loadGlobalStored("appNavigationPinned", true),
  );

  useEffect(() => {
    if (!navigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      // The active overlay owns Escape and returns focus to the open navigation.
      const overlaySelector = '[role="dialog"], [role="menu"]';
      const fromOverlay = event.target instanceof Element && event.target.closest(overlaySelector);
      if (event.key === "Escape" && !fromOverlay && !document.querySelector(overlaySelector)) {
        setNavigationOpen(false);
        navigationToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  // Navigation itself happens through the router links below; this only
  // handles the shell chrome (mobile menu, unpinned sidebar collapse).
  function handleNavigationSelect() {
    setNavigationOpen(false);
    if (!appNavigationPinned) {
      setAppNavigationExpanded(false);
      saveGlobalStored("appNavigationExpanded", false);
    }
  }

  function toggleAppNavigation() {
    const nextExpanded = !appNavigationExpanded;
    setAppNavigationExpanded(nextExpanded);
    saveGlobalStored("appNavigationExpanded", nextExpanded);
  }

  function toggleAppNavigationPin() {
    const nextPinned = !appNavigationPinned;
    setAppNavigationPinned(nextPinned);
    saveGlobalStored("appNavigationPinned", nextPinned);
    if (nextPinned) {
      setAppNavigationExpanded(true);
      saveGlobalStored("appNavigationExpanded", true);
    }
  }

  return (
    <MantineAppShell
      className={appNavigationExpanded ? "app-shell" : "app-shell is-navigation-collapsed"}
      header={{ height: { base: 68, sm: 0 } }}
      navbar={{ width: appNavigationExpanded ? 280 : 80, breakpoint: "sm", collapsed: { mobile: !navigationOpen } }}
      padding={{ base: "md", sm: "xl" }}
      styles={{ root: { display: "block", height: "100dvh", overflow: "hidden" } }}
    >
      <a className="skip-link" href="#main-content">Skip to content</a>
      <MantineAppShell.Header hiddenFrom="sm" px="md">
        <Group justify="space-between" h="100%">
          <Group gap="sm"><img alt="" src="/logo.png" width={36} height={36} /><Text fw={700}>Klippee</Text></Group>
          <ActionIcon
            ref={navigationToggleRef}
            aria-controls="primary-navigation"
            aria-expanded={navigationOpen}
            aria-label={navigationOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setNavigationOpen((open) => !open)}
            type="button"
          >{navigationOpen ? <X size={22} /> : <Menu size={22} />}</ActionIcon>
        </Group>
      </MantineAppShell.Header>
      <MantineAppShell.Navbar
        onBlurCapture={(event) => {
          const next = event.relatedTarget;
          if (navigationOpen && next instanceof Element && !event.currentTarget.contains(next)
            && next !== navigationToggleRef.current && !next.closest('[role="dialog"], [role="menu"]')) setNavigationOpen(false);
        }}
        className={[
          "sidebar",
          navigationOpen ? "is-menu-open" : "",
          appNavigationExpanded ? "" : "is-collapsed",
          appNavigationPinned ? "is-pinned" : "",
        ].filter(Boolean).join(" ")}
        aria-label="Klippee navigation"
        p="md"
        bg="var(--bg-rail)"
      >
        <MantineAppShell.Section grow component={ScrollArea} className="sidebar-main" offsetScrollbars>
          <div className="sidebar-header-row">
            <div className="brand-lockup">
              <img alt="" className="brand-logo" src="/logo.png" />
              <div>
                <Text fw={700} size="lg">Klippee</Text>
              </div>
            </div>
            <div className="desktop-sidebar-controls">
              {appNavigationExpanded ? (
                <ActionIcon
                  aria-label={appNavigationPinned ? "Unpin app menu" : "Pin app menu"}
                  aria-pressed={appNavigationPinned}
                  className={appNavigationPinned ? "sidebar-control is-active" : "sidebar-control"}
                  onClick={toggleAppNavigationPin}
                  title={appNavigationPinned ? "Unpin app menu" : "Pin app menu open"}
                  type="button"
                >
                  {appNavigationPinned ? <PinOff size={16} /> : <Pin size={16} />}
                </ActionIcon>
              ) : null}
              <ActionIcon
                aria-label={appNavigationExpanded ? "Collapse app menu" : "Expand app menu"}
                className="sidebar-control"
                onClick={toggleAppNavigation}
                title={appNavigationExpanded ? "Collapse app menu" : "Expand app menu"}
                type="button"
              >
                {appNavigationExpanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
              </ActionIcon>
            </div>
          </div>
          <nav className="tab-list" aria-label="Primary" id="primary-navigation">
            {primaryTabs.map((tab) => (
              <NavLink
                component={Link}
                active={activeTab === tab}
                aria-current={activeTab === tab ? "page" : undefined}
                aria-label={tabLabels[tab]}
                className={activeTab === tab ? "tab is-active" : "tab"}
                key={tab}
                onClick={handleNavigationSelect}
                title={appNavigationExpanded ? undefined : tabLabels[tab]}
                to={tabPaths[tab]}
                label={tabLabels[tab]}
                styles={{ label: { fontSize: "1rem" }, root: { borderRadius: "var(--mantine-radius-md)", minHeight: 44, paddingInline: appNavigationExpanded ? 12 : 0 }, section: { marginInlineEnd: appNavigationExpanded ? 10 : 0 } }}
                leftSection={(
                  <>
                    {tab === "Setup" && <CheckCircle2 size={20} />}
                    {tab === "Slicer" && <FileSliders size={20} />}
                    {tab === "Printers" && <Printer size={20} />}
                    {tab === "Registry" && <BookOpen size={20} />}
                    {tab === "Diagnostics" && <FileSearch size={20} />}
                    {tab === "Gridfinity" && <Grid3X3 size={20} />}
                    {tab === "OpenGrid" && <LayoutGrid size={20} />}
                    {tab === "Underware" && <Cable size={20} />}
                  </>
                )}
              />
            ))}
          </nav>
        </MantineAppShell.Section>
        <MantineAppShell.Section className="sidebar-auth-slot">
          <Separator />
          <NavLink
            component="a"
            aria-label="Documentation"
            className="documentation-link"
            href="https://cl-tim.github.io/klippee-web/"
            rel="noopener noreferrer"
            target="_blank"
            title="Documentation"
            label="Documentation"
            leftSection={<ExternalLink size={20} aria-hidden="true" />}
            styles={{ root: { minHeight: 44, borderRadius: "var(--mantine-radius-md)", color: "var(--muted-foreground)", paddingInline: appNavigationExpanded ? 12 : 0 }, label: { fontSize: "1rem" }, section: { marginInlineEnd: appNavigationExpanded ? 10 : 0 } }}
          />
          <NavLink
            component="a"
            aria-label="Support me"
            className="support-link"
            href="https://ko-fi.com/tquinn"
            rel="noreferrer"
            target="_blank"
            label="Support me"
            leftSection={<Heart size={20} />}
            styles={{ root: { minHeight: 44, borderRadius: "var(--mantine-radius-md)", color: "var(--muted-foreground)", paddingInline: appNavigationExpanded ? 12 : 0 }, label: { fontSize: "1rem" }, section: { marginInlineEnd: appNavigationExpanded ? 10 : 0 } }}
          />
          <AuthPanel />
        </MantineAppShell.Section>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="workbench" id="main-content" tabIndex={-1} style={{ height: "100dvh" }}>
        {storageStatus.error ? (
          <Alert color="yellow" role="alert" mb="md" title="Saving on this device needs attention">
            <Stack gap="sm"><Text>{storageStatus.error}</Text>
            {storageStatus.pending > 0 ? <Text>Saving changes…</Text> : storageStatus.retryable ? (
              <Button onClick={() => void storageStatus.retry().catch(() => undefined)} variant="default" type="button">Retry save</Button>
            ) : null}
            </Stack>
          </Alert>
        ) : null}
        <Routes>
          <Route element={<ProtectedRoute><KlipperWorkspaceView /></ProtectedRoute>} path="/" />
          <Route element={<ProtectedRoute><KlipperWorkspaceView /></ProtectedRoute>} path="/klipper-configs" />
          <Route element={<ProtectedRoute><OrcaWorkspaceView /></ProtectedRoute>} path="/slicer" />
          <Route element={<ProtectedRoute><PrintersView /></ProtectedRoute>} path="/printers" />
          <Route element={<RegistryRoute />} path="/shared-configs" />
          <Route element={<LegacyRegistryRedirect />} path="/registry" />
          <Route element={<RegistryRoute />} path="/packages/:packageId" />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Loading preset" />}>
                <PublicAssetView />
              </Suspense>
            )}
            path="/assets/:slug"
          />
          <Route element={<Navigate replace to="/printers" />} path="/sync" />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing log analyzer" />}>
                <LogDiagnosticsView />
              </Suspense>
            )}
            path="/log-diagnostics"
          />
          <Route element={<Navigate replace to="/gridfinity" />} path="/openscad" />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing CAD workspace" />}>
                <OpenScadView />
              </Suspense>
            )}
            path="/openscad-studio"
          />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing converter" />}>
                <ScadToBuild123dView />
              </Suspense>
            )}
            path="/scad-to-build123d"
          />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing Gridfinity Editor" />}>
                <ParametricCadEditor key="gridfinity" kind="gridfinity" />
              </Suspense>
            )}
            path="/gridfinity"
          />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing OpenGrid Editor" />}>
                <ParametricCadEditor key="opengrid" kind="opengrid" />
              </Suspense>
            )}
            path="/opengrid"
          />
          <Route
            element={(
              <Suspense fallback={<EmptyPanel title="Preparing OpenGrid Underware Editor" />}>
                <ParametricCadEditor key="underware" kind="underware" />
              </Suspense>
            )}
            path="/opengrid-underware"
          />
          <Route element={<Navigate replace to="/klipper-configs" />} path="*" />
        </Routes>
      </MantineAppShell.Main>
      <PrinterDetailsModal />
    </MantineAppShell>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { protectedDataPending, protectedTabLocked } = useAppShellContext();
  if (protectedDataPending) {
    return (
      <EmptyPanel
        title="Loading your workspace"
      />
    );
  }
  return protectedTabLocked ? <AuthRequiredPanel /> : children;
}

function LegacyRegistryRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: "/shared-configs", search, hash }} />;
}

function RegistryRoute() {
  const { setActiveTab } = useAppShellContext();
  const { selectPackage } = usePackageContext();

  return (
    <RegistryView
      onConfigure={(id) => {
        selectPackage(id);
        setActiveTab("Setup");
      }}
    />
  );
}
