import { Clock3, Download, PanelLeftOpen, Printer } from "lucide-react";
import { Button, Drawer, Title } from "@mantine/core";
import { Card } from "@/components/ui/card";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMediaQuery } from "@mantine/hooks";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { usePrinterContext } from "../../app/contexts/usePrinterContext";
import { useRepositoryContext } from "../../app/contexts/useRepositoryContext";
import { useWorkspaceContext } from "../../app/contexts/useWorkspaceContext";
import { ConfigImportConfirmModal } from "./components/ConfigImportConfirmModal";
import { PrinterCard } from "./components/PrinterCard";
import { RegistryPublisherModal } from "./components/RegistryPublisherModal";
import { WorkspaceEditor } from "./components/WorkspaceEditor";
import { WorkspaceFileBrowser } from "./components/WorkspaceFileBrowser";
import { WorkspaceRecoveryModal } from "./components/WorkspaceRecoveryModal";

export function SlicerWorkspaceView() {
  const { setActiveTab } = useAppShellContext();
  const { selectedPrinter } = usePrinterContext();
  const { history } = useRepositoryContext();
  const { workspaceFilePath } = useWorkspaceContext();
  const navigate = useNavigate();
  const compactNavigation = useMediaQuery("(max-width: 980px)", false, { getInitialValueInEffect: false });
  const [publisherOpen, setPublisherOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  function closeNavigation() {
    setNavigatorOpen(false);
  }

  const navigationContents = (
    <WorkspaceNavigationContents
      historyCount={history.length}
      navigationId={compactNavigation ? "slicer-workspace-navigation" : undefined}
      onClose={closeNavigation}
      onFileSelected={compactNavigation ? closeNavigation : undefined}
      onOpenRecovery={() => setRecoveryOpen(true)}
      onOpenCli={() => void navigate("/printers?section=cli")}
    />
  );

  if (!selectedPrinter) {
    return (
      <Card className="panel workspace-printer-required grid place-content-center justify-items-center px-6">
        <div className="workspace-printer-required-icon"><Printer size={24} /></div>
        <div>
          <Title order={2}>Choose a printer for this workspace</Title>
        </div>
        <Button className="primary-action" onClick={() => setActiveTab("Printers")}>Open Printers</Button>
      </Card>
    );
  }

  return (
    <div className="panel slicer-layout">
      {compactNavigation ? (
        <Drawer
          closeButtonProps={{ "aria-label": "Close files and printer" }}
          closeOnEscape
          closeOnClickOutside
          onClose={closeNavigation}
          opened={navigatorOpen}
          position="left"
          returnFocus
          size="min(92vw, 380px)"
          title="Files & printer"
          trapFocus
          withOverlay
          zIndex={120}
          classNames={{ content: "slicer-left", header: "slicer-navigation-header", body: "slicer-navigation-body" }}
        >
          {navigationContents}
        </Drawer>
      ) : (
        <aside aria-label="Workspace files and printer" className="slicer-left" id="slicer-workspace-navigation">
          {navigationContents}
        </aside>
      )}

      <section aria-label="Configuration editor" className="slicer-workspace-main">
        <section aria-label="Workspace context" className="slicer-compact-bar">
          <div>
            <span>Current configuration</span>
            <strong title={workspaceFilePath}>{workspaceFilePath || "No config file selected"}</strong>
          </div>
          <Button
            aria-label="Files & printer"
            aria-controls="slicer-workspace-navigation"
            aria-expanded={navigatorOpen}
            className="inline-action"
            onClick={() => setNavigatorOpen(true)}
            variant="subtle"
          >
            <PanelLeftOpen size={17} />
            <span>Files &amp; printer</span>
          </Button>
        </section>
        <WorkspaceEditor key={workspaceFilePath} onOpenPublisher={() => setPublisherOpen(true)} />
      </section>

      <ConfigImportConfirmModal />
      <RegistryPublisherModal onClose={() => setPublisherOpen(false)} open={publisherOpen} />
      {recoveryOpen && <WorkspaceRecoveryModal key={selectedPrinter.id} onClose={() => setRecoveryOpen(false)} open />}
    </div>
  );
}

function WorkspaceNavigationContents({
  historyCount,
  navigationId,
  onClose,
  onFileSelected,
  onOpenRecovery,
  onOpenCli,
}: {
  historyCount: number;
  navigationId?: string;
  onClose: () => void;
  onFileSelected?: () => void;
  onOpenRecovery: () => void;
  onOpenCli: () => void;
}) {
  return (
    <div className="slicer-navigation-body" id={navigationId}>
      <PrinterCard />
      <WorkspaceFileBrowser onFileSelected={onFileSelected} />
      <nav aria-label="Workspace actions" className="slicer-navigation-actions">
        <Button
          className="inline-action"
          onClick={() => {
            onClose();
            onOpenRecovery();
          }}
          variant="default"
          styles={{ root: { height: "auto", minHeight: 60, padding: "8px 10px" }, label: { whiteSpace: "normal", textAlign: "left" } }}
        >
          <Clock3 size={16} />
          <span style={{ display: "grid", gap: 2 }}><strong>Recovery</strong><small>{historyCount} point{historyCount === 1 ? "" : "s"}</small></span>
        </Button>
        <Button
          className="inline-action"
          onClick={() => {
            onClose();
            onOpenCli();
          }}
          variant="default"
          styles={{ root: { height: "auto", minHeight: 60, padding: "8px 10px" }, label: { whiteSpace: "normal", textAlign: "left" } }}
        >
          <Download size={16} />
          <span style={{ display: "grid", gap: 2 }}><strong>Install</strong><small>Use the CLI</small></span>
        </Button>
      </nav>
    </div>
  );
}
