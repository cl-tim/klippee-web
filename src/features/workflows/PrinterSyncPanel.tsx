import {
  DownloadCloud,
  Link2,
  LoaderCircle,
  RefreshCw,
  Settings2,
  UploadCloud,
  Wrench,
} from "lucide-react";
import { Button, SimpleGrid, Tabs, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { usePrinterContext } from "../../app/contexts/usePrinterContext";
import { useRepositoryContext } from "../../app/contexts/useRepositoryContext";
import { formatDate } from "../../app/format";
import { CommandSnippet } from "../../components/CommandSnippet";
import { RiskWarning, SectionHeader, StatusBlock } from "../../components/common";
import { HelpRow } from "../../components/FieldHelp";
import { HlabReleaseDownloads } from "./components/HlabReleaseDownloads";
import {
  DesktopIntegration,
  PrinterDangerZone,
  PrinterDetailHeader,
  PrinterDetailsCard,
  PrinterHostDetails,
  SetupProgress,
  TokenList,
} from "./components/PrinterManagementComponents";
import { summarizePrinterManagement } from "./printerManagement";

type PrinterManagementSection = "overview" | "cli" | "integrations" | "settings";

const managementSections: Array<{
  id: PrinterManagementSection;
  label: string;
}> = [
  { id: "overview", label: "Overview" },
  { id: "cli", label: "CLI" },
  { id: "integrations", label: "Integrations" },
  { id: "settings", label: "Settings" },
];

export function PrinterSyncPanel() {
  const {
    selectedPrinter,
    switchingPrinterId,
  } = usePrinterContext();
  const { setActiveTab } = useAppShellContext();
  const {
    appliedVersion,
    buildDesktopInstallCommand,
    buildPrinterInstallCommand,
    latestVersion,
    pendingConfiguration,
    repoStatus,
    syncStatus,
    syncCheckedAt,
    syncPullUrl,
    syncTokens,
    createDesktopSyncToken,
    createPrinterSyncToken,
    linkCurrentPrinter,
    loadActiveRepositoryHistory,
    refreshSyncStatus,
    revokeSyncToken,
  } = useRepositoryContext();
  const [searchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const [activeSection, setActiveSection] = useState<PrinterManagementSection>(
    requestedSection === "cli" ? "cli" : "overview",
  );
  const [configDirectory, setConfigDirectory] = useState("");

  if (!selectedPrinter) {
    return (
      <section className="printer-sync-detail printer-detail-empty">
        <SectionHeader
          title="Select a printer"
        />
      </section>
    );
  }

  if (switchingPrinterId) {
    return (
      <section aria-live="polite" className="printer-sync-detail printer-detail-loading">
        <LoaderCircle className="is-spinning" size={24} />
        <div>
          <strong>Loading {selectedPrinter.name}</strong>
          <Text>Retrieving its private configuration and connection state.</Text>
        </div>
      </section>
    );
  }

  const summary = summarizePrinterManagement(selectedPrinter);
  const connectionLabel = selectedPrinter.hostInfoUpdatedAt
    ? `Last report ${formatDate(selectedPrinter.hostInfoUpdatedAt)}`
    : "No host report";
  const openWorkspace = () => setActiveTab("Setup");

  if (!syncPullUrl) {
    return (
      <section className="printer-sync-detail">
        <PrinterDetailHeader
          configDetail={summary.configDetail}
          configLabel={summary.configLabel}
          connectionLabel={connectionLabel}
          onOpenWorkspace={openWorkspace}
          onRefresh={refreshSyncStatus}
          printer={selectedPrinter}
          showRefresh={false}
          tone={summary.tone}
        />
        <SetupProgress state="profile" />
        <section className="printer-onboarding-card">
          <div className="printer-onboarding-icon"><Link2 size={22} /></div>
          <div>
            <HelpRow label="Connect the physical printer" help="Klippee will create a private configuration repository, then guide you through one safe import command. Nothing is changed on the printer during this step."><Title order={3}>Connect the physical printer</Title></HelpRow>
          </div>
          <Button className="primary-action" onClick={linkCurrentPrinter}>
            Connect printer
          </Button>
        </section>
        <details className="printer-secondary-details">
          <summary><Settings2 size={16} /><span>Printer details</span></summary>
          <PrinterDetailsCard
            key={selectedPrinter.id}
            printer={selectedPrinter}
          />
          <PrinterDangerZone printer={selectedPrinter} />
        </details>
      </section>
    );
  }

  if (!latestVersion) {
    const captureCommand = buildPrinterInstallCommand(configDirectory, true);

    async function checkCapture() {
      await loadActiveRepositoryHistory();
      await refreshSyncStatus();
    }

    return (
      <section className="printer-sync-detail">
        <PrinterDetailHeader
          configDetail={summary.configDetail}
          configLabel={summary.configLabel}
          connectionLabel={connectionLabel}
          onOpenWorkspace={openWorkspace}
          onRefresh={refreshSyncStatus}
          printer={selectedPrinter}
          showRefresh={false}
          tone={summary.tone}
        />
        <SetupProgress state="capture" />
        <section className="printer-onboarding-card is-stacked">
          <div className="printer-onboarding-icon"><DownloadCloud size={22} /></div>
          <div>
            <HelpRow label="Connect hlab and capture the current configuration" help={<>Run the generated command on the printer host. It captures safe files loaded from <code>printer.cfg</code>.</>}><Title order={3}>Connect hlab and capture the current configuration</Title></HelpRow>
          </div>
          <HlabReleaseDownloads platform="printer" />
          <TextInput className="field printer-path-field" label="Configuration folder" description="Optional"
              onChange={(event) => setConfigDirectory(event.target.value)}
              placeholder="Default: ~/printer_data/config"
              value={configDirectory}
          />
          {captureCommand ? (
            <div className="printer-install-command">
              <CommandSnippet command={captureCommand} label="Connect and capture" />
              <p>The command contains a one-time credential. Run it privately and do not share it.</p>
            </div>
          ) : (
            <div className="sync-token-needed">
              <p>Generate the private setup command when you are ready to run it.</p>
              <Button className="primary-action" onClick={createPrinterSyncToken}>Generate setup command</Button>
            </div>
          )}
          <div className="printer-import-check">
            <div>
              <strong>Already ran the command?</strong>
              <span>Check whether the desired configuration arrived.</span>
            </div>
            <Button className="inline-action" leftSection={<RefreshCw size={16} />} onClick={checkCapture} variant="subtle">Check capture</Button>
          </div>
          <p className="muted-line">{repoStatus} · {syncStatus}</p>
        </section>
        <details className="printer-secondary-details">
          <summary><Settings2 size={16} /><span>Printer details</span></summary>
          <PrinterDetailsCard key={selectedPrinter.id} printer={selectedPrinter} />
          <PrinterDangerZone printer={selectedPrinter} />
        </details>
      </section>
    );
  }

  const targetVersion = latestVersion;
  const updateAvailable = Boolean(pendingConfiguration) || !appliedVersion || appliedVersion.id !== targetVersion.id;
  const configLabel = pendingConfiguration
    ? "Draft available"
    : !appliedVersion
    ? "Applied state unknown"
    : updateAvailable
      ? "Update available"
      : "Configuration current";
  const configTone = pendingConfiguration || updateAvailable ? "attention" : !appliedVersion ? "muted" : "ready";
  const configDetail = pendingConfiguration
    ? `A ${pendingConfiguration.fileCount}-file draft is ready for an explicit printer apply.`
    : !appliedVersion
    ? "The printer has not reported whether it matches the desired configuration."
    : updateAvailable
      ? "The desired configuration has not been applied to this printer."
      : "The printer reports that it matches the desired configuration.";
  const reinstallCommand = buildPrinterInstallCommand(configDirectory);

  return (
    <section className="printer-sync-detail">
      <PrinterDetailHeader
        configDetail={configDetail}
        configLabel={configLabel}
        connectionLabel={connectionLabel}
        onOpenWorkspace={openWorkspace}
        onRefresh={refreshSyncStatus}
        printer={selectedPrinter}
        showRefresh
        tone={configTone}
      />

      <Tabs className="printer-management-tabs" onChange={(value) => value && setActiveSection(value as PrinterManagementSection)} value={activeSection}>
        <Tabs.List aria-label="Printer management" mb="md" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--mantine-radius-md)", padding: 4, flexWrap: "nowrap", overflowX: "auto" }}>
          {managementSections.map((section) => <Tabs.Tab key={section.id} value={section.id}>{section.label}</Tabs.Tab>)}
        </Tabs.List>

      <Tabs.Panel value="overview">
        <div className="printer-management-section">
          <div className="printer-version-overview">
            <StatusBlock
              label="Printer target"
              value={pendingConfiguration ? "Draft available" : "Applied configuration"}
              detail={pendingConfiguration
                ? `Draft saved ${formatDate(pendingConfiguration.updatedAt)}`
                : latestVersion.message}
            />
            <StatusBlock
              label="Last confirmed on printer"
              value={!appliedVersion ? "Not reported" : updateAvailable ? "Needs apply" : "Current"}
              detail={selectedPrinter.appliedAt
                ? formatDate(selectedPrinter.appliedAt)
                : appliedVersion?.message ?? "Waiting for the printer client"}
            />
          </div>
          {syncCheckedAt && <Text size="sm" c="dimmed">Cloud status refreshed {formatDate(syncCheckedAt)}</Text>}
          <details className="printer-host-details">
            <summary>
              <span><Wrench size={16} /><strong>Host software details</strong></span>
            </summary>
            <PrinterHostDetails printer={selectedPrinter} />
          </details>
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="cli">
        <div className="printer-management-section">
          <section className="cli-install-card">
            <div className="cli-step-heading">
              <span>1</span>
              <div>
                <HelpRow label="Connect hlab" help={<>Run the setup command on the printer host to link hlab to this printer.</>}><Title order={3}>Connect hlab</Title></HelpRow>
              </div>
            </div>
            <HlabReleaseDownloads platform="printer" />
            <TextInput className="field" label="Configuration folder" description="Optional"
                onChange={(event) => setConfigDirectory(event.target.value)}
                placeholder="Default: ~/printer_data/config"
                value={configDirectory}
            />
            {reinstallCommand ? (
              <>
                <CommandSnippet command={reinstallCommand} label="Connect hlab to this printer" />
                <p className="muted-line">The command contains a private one-time credential. Do not share it.</p>
              </>
            ) : (
              <div className="sync-token-needed">
                <p>Generate a private command when you are ready to connect hlab.</p>
                <Button className="primary-action" onClick={createPrinterSyncToken}>Generate setup command</Button>
              </div>
            )}
          </section>

          <section className="cli-command-card">
            <div className="cli-step-heading">
              <span>2</span>
              <div>
                <HelpRow label="Check what will change" help={<>Confirm the service, printer target, folder, and configuration drift before changing anything.</>}><Title order={3}>Check what will change</Title></HelpRow>
              </div>
            </div>
            <div className="cli-command-grid">
              <CommandSnippet command="hlab klippee target" label="Confirm this target" />
              <CommandSnippet command="hlab klippee check --diff" label="Review configuration drift" />
            </div>
          </section>

          <section className="cli-command-card">
            <div className="cli-step-heading">
              <span>3</span>
              <div>
                <HelpRow label="Choose which configuration wins" help={<>Capture keeps the printer's current files. Apply replaces them with the desired configuration.</>}><Title order={3}>Choose which configuration wins</Title></HelpRow>
              </div>
            </div>
            <div className="cli-command-grid">
              <div className="cli-sync-direction">
                <SectionHeader
                  action={<UploadCloud size={18} />}
                  help="Make this printer's current safe configuration the desired state."
                  title="Keep printer configuration"
                />
                <CommandSnippet command="hlab klippee capture" label="Capture current configuration" />
              </div>
              <div className="cli-sync-direction">
                <SectionHeader
                  action={<DownloadCloud size={18} />}
                  help="Back up the current files and replace them with the desired configuration."
                  title="Use desired configuration"
                />
                <CommandSnippet command="hlab klippee apply" label="Apply desired configuration" />
              </div>
            </div>
            <RiskWarning
              title="Before applying to hardware"
              warnings={[
                "Review pins, thermistors, motion limits, and included files for this exact printer.",
                "Klippee shows the exact target and changed paths, asks before replacement, and creates a local backup.",
              ]}
            />
          </section>

          <details className="printer-secondary-details">
            <summary><Settings2 size={16} /><span>Manage CLI access</span></summary>
            <TokenList createToken={createPrinterSyncToken} revokeToken={revokeSyncToken} tokens={syncTokens} />
          </details>
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="integrations">
        <div className="printer-management-section">
          <section className="sync-setup-card">
            <SectionHeader
              action={<Link2 size={18} />}
              help="Add safe dashboard macros for sync and private diagnostics. The agent blocks configuration changes during a print."
              title="Mainsail and Fluidd"
            />
            <CommandSnippet command="hlab klippee install-moonraker" label="Install dashboard controls" />
            <p className="muted-line">Run this on the printer host, then restart Klipper once to load the KLIPPEE_CHECK, KLIPPEE_CAPTURE, KLIPPEE_APPLY, and KLIPPEE_UPLOAD_DIAGNOSTICS macros.</p>
          </section>
          <DesktopIntegration
            buildDesktopInstallCommand={buildDesktopInstallCommand}
            createDesktopSyncToken={createDesktopSyncToken}
          />
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="settings">
        <SimpleGrid className="printer-management-section settings-management-grid" cols={{ base: 1, lg: 2 }} spacing="md">
          <PrinterDetailsCard key={selectedPrinter.id} printer={selectedPrinter} />
          <PrinterDangerZone printer={selectedPrinter} />
        </SimpleGrid>
      </Tabs.Panel>
      </Tabs>
    </section>
  );
}
