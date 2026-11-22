import { HelpRow } from "../../../components/FieldHelp";
import { Check, FileCode2, Laptop, RefreshCw, Save, Trash2 } from "lucide-react";
import { ActionIcon, Badge, Button, Group, SegmentedControl, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { useState } from "react";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { formatDate } from "../../../app/format";
import type { PrinterRecord, SyncTokenRecord } from "../../../app/types";
import { CommandSnippet } from "../../../components/CommandSnippet";
import { SectionHeader, StatusBlock } from "../../../components/common";
import type { PrinterSetupState } from "../printerManagement";
import { HlabReleaseDownloads } from "./HlabReleaseDownloads";

export function TokenList({
  createToken,
  revokeToken,
  tokens,
}: {
  createToken: () => Promise<void>;
  revokeToken: (tokenId: string) => Promise<void>;
  tokens: SyncTokenRecord[];
}) {
  const [pendingRevokeId, setPendingRevokeId] = useState("");

  return (
    <section className="token-panel">
      <SectionHeader
        help="Clients use revocable credentials restricted to this printer's private configuration."
        title="Client access"
      />
      <Button className="inline-action token-create-action" onClick={createToken} variant="subtle">
        New printer token
      </Button>
      {tokens.length > 0 ? (
        <div className="token-list">
          {tokens.map((token) => (
            <div className="token-row" key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <span>{token.printer_id ? "Printer client" : "Repository client"} · {token.token_prefix}...</span>
                <span>{token.last_used_at ? `Last used ${formatDate(token.last_used_at)}` : `Created ${formatDate(token.created_at)}`}</span>
              </div>
              {pendingRevokeId === token.id ? (
                <div aria-label={`Confirm revoke ${token.name}`} className="token-revoke-confirm" role="group">
                  <span>Clients using this credential will stop syncing immediately.</span>
                  <div>
                    <Button
                      className="danger-action"
                      color="red"
                      onClick={async () => {
                        await revokeToken(token.id);
                        setPendingRevokeId("");
                      }}
                      type="button"
                      variant="outline"
                    >
                      Revoke token
                    </Button>
                    <Button className="inline-action" onClick={() => setPendingRevokeId("")} variant="subtle">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <ActionIcon
                  aria-label={`Revoke ${token.name}`}
                  className="icon-button danger-icon"
                  color="red"
                  onClick={() => setPendingRevokeId(token.id)}
                  size={44}
                  title="Revoke token"
                  variant="subtle"
                >
                  <Trash2 size={16} />
                </ActionIcon>
              )}
            </div>
          ))}
        </div>
      ) : <p className="muted-line">No active client tokens.</p>}
    </section>
  );
}

export function PrinterDetailsCard({ printer }: { printer: PrinterRecord }) {
  const { updatePrinterDetails } = usePrinterContext();
  const [draft, setDraft] = useState({ description: printer.description, name: printer.name });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const detailsChanged = draft.name.trim() !== printer.name || draft.description.trim() !== printer.description;

  async function saveDetails() {
    setSaveState("saving");
    const saved = await updatePrinterDetails(printer.id, draft);
    setSaveState(saved ? "saved" : "error");
  }

  return (
    <section className="sync-setup-card">
      <SectionHeader title="Printer details" />
      <Stack gap="md">
        <TextInput
          className="field"
          label="Name"
          aria-required="true"
          disabled={saveState === "saving"}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
            setSaveState("idle");
          }}
          placeholder="Printer name"
          value={draft.name}
        />
        <Textarea
          className="field"
          label="Description"
          disabled={saveState === "saving"}
          onChange={(event) => {
            setDraft((current) => ({ ...current, description: event.target.value }));
            setSaveState("idle");
          }}
          placeholder="Location, hardware, or role"
          value={draft.description}
        />
        <Group>
          <Button
            className="inline-action"
            disabled={saveState === "saving" || !draft.name.trim() || (!detailsChanged && saveState !== "error")}
            leftSection={<Save size={16} />}
            onClick={() => void saveDetails()}
            title={saveState === "error" ? "Retry saving these printer details" : detailsChanged ? "Save these printer details" : "No detail changes to save"}
            variant="default"
          >
            {saveState === "saving" ? "Saving details…" : "Save details"}
          </Button>
        </Group>
        {saveState === "saved" && <Text role="status" size="sm">Printer details saved.</Text>}
        {saveState === "error" && <Text role="alert" size="sm" c="red">Could not save printer details. Try again.</Text>}
      </Stack>
    </section>
  );
}

export function PrinterDangerZone({ printer }: { printer: PrinterRecord }) {
  const {
    cancelDeletePrinter,
    confirmDeletePrinter,
    pendingDeletePrinterId,
    requestDeletePrinter,
  } = usePrinterContext();
  const [confirmationText, setConfirmationText] = useState("");
  const deletionConfirmed = confirmationText === printer.name;

  return (
    <section className="printer-danger-zone">
      <SectionHeader
        action={<Trash2 size={18} />}
        help="Remove this printer profile and its connection credentials. Private recovery history is kept."
        title="Delete printer"
      />
      {pendingDeletePrinterId === printer.id ? (
        <Stack className="printer-delete-confirm" gap="md">
          <strong>Delete {printer.name}?</strong>
          <p>
            Client tokens and private diagnostic uploads for this printer are removed immediately. Its private
            desired configuration and recovery history stay in your account.
          </p>
          <TextInput
            className="field"
            aria-label={`Type ${printer.name} to confirm deletion`}
            autoFocus
            label={<>Type <code>{printer.name}</code> to confirm</>}
            onChange={(event) => setConfirmationText(event.target.value)}
            value={confirmationText}
          />
          <Group gap="sm">
            <Button
              className="danger-action"
              color="red"
              disabled={!deletionConfirmed}
              onClick={() => confirmDeletePrinter(printer.id)}
              variant="filled"
            >
              Delete printer
            </Button>
            <Button
              className="inline-action"
              onClick={() => {
                setConfirmationText("");
                cancelDeletePrinter();
              }}
              variant="subtle"
            >
              Cancel
            </Button>
          </Group>
        </Stack>
      ) : (
        <Button
          className="danger-action"
          color="red"
          onClick={() => {
            setConfirmationText("");
            requestDeletePrinter(printer.id);
          }}
          variant="filled"
        >
          Delete {printer.name}
        </Button>
      )}
    </section>
  );
}

export function PrinterHostDetails({ printer }: { printer: PrinterRecord }) {
  const info = printer.hostInfo ?? {};
  const hasInfo = Object.values(info).some(Boolean);

  if (!hasInfo) {
    return (
      <p className="muted-line">
        No host details have been reported. They arrive after the printer client completes an apply or capture.
      </p>
    );
  }

  return (
    <div className="sync-status">
      {info.os || info.kernel || info.arch ? (
        <StatusBlock
          label="Operating system"
          value={info.os || "Unknown"}
          detail={[info.kernel, info.arch].filter(Boolean).join(" · ")}
        />
      ) : null}
      {info.hostname ? <StatusBlock label="Hostname" value={info.hostname} detail="" /> : null}
      {info.klipperVersion || info.klippyState ? (
        <StatusBlock
          label="Klipper"
          value={info.klipperVersion || "Unknown"}
          detail={info.klippyState ? `Klippy ${info.klippyState}` : ""}
        />
      ) : null}
      {info.moonrakerVersion ? <StatusBlock label="Moonraker" value={info.moonrakerVersion} detail="" /> : null}
      {info.cliVersion ? <StatusBlock label="Klippee client" value={info.cliVersion} detail="" /> : null}
    </div>
  );
}

export function SetupProgress({ state }: { state: PrinterSetupState }) {
  const activeStep = state === "profile" ? 1 : state === "capture" ? 2 : 3;
  const steps = [
    ["1", "Create profile", "Name the printer and prepare its private workspace."],
    ["2", "Install and capture", "Run one setup command on the printer host."],
    ["3", "Ready", "Review the target and manage configuration updates."],
  ];

  return (
    <ol className="sync-steps" aria-label="Printer setup progress">
      {steps.map(([number, title, detail], index) => {
        const step = index + 1;
        const className = step < activeStep ? "is-complete" : step === activeStep ? "is-current" : "";
        return (
          <li className={className} key={number}>
            <span>{step < activeStep ? <Check size={14} /> : number}</span>
            <div>
              <strong>{title}</strong>
              <small>{detail}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PrinterDetailHeader({
  configDetail,
  configLabel,
  connectionLabel,
  onOpenWorkspace,
  onRefresh,
  printer,
  showRefresh,
  tone,
}: {
  configDetail: string;
  configLabel: string;
  connectionLabel: string;
  onOpenWorkspace: () => void;
  onRefresh: () => void;
  printer: PrinterRecord;
  showRefresh: boolean;
  tone: "attention" | "muted" | "ready";
}) {
  return (
    <header className="printer-detail-header">
      <div className="printer-detail-title">
        <h2>{printer.name}</h2>
        <div className="printer-detail-badges">
          <Badge className={`printer-state-badge is-${tone}`} variant="light">{configLabel}</Badge>
          <Badge className="printer-connection-badge" variant="outline">{connectionLabel}</Badge>
        </div>
        <small>{configDetail}</small>
      </div>
      <div className="printer-detail-actions">
        <Button className="primary-action" leftSection={<FileCode2 size={16} />} onClick={onOpenWorkspace}>Open configuration</Button>
        {showRefresh ? (
          <Button className="inline-action" leftSection={<RefreshCw size={16} />} onClick={onRefresh} variant="subtle">Refresh cloud status</Button>
        ) : null}
      </div>
    </header>
  );
}

export function DesktopIntegration({
  buildDesktopInstallCommand,
  createDesktopSyncToken,
}: {
  buildDesktopInstallCommand: (platform: "windows" | "unix") => string;
  createDesktopSyncToken: () => Promise<void>;
}) {
  const [desktopPlatform, setDesktopPlatform] = useState<"windows" | "unix">("windows");
  const desktopInstallCommand = buildDesktopInstallCommand(desktopPlatform);

  return (
    <section className="desktop-sync-workflow">
      <SectionHeader
        action={<Laptop size={18} />}
        help="Download this printer's configuration into a normal folder and edit it in your IDE."
        title="Desktop IDE"
      />

      <section className="cli-command-card">
        <div className="cli-step-heading">
          <span>1</span>
          <div>
            <HelpRow label="Create your configuration folder" help={<>Create a normal folder for this printer, then open a terminal inside it.</>}><h3>Create your configuration folder</h3></HelpRow>
          </div>
        </div>
        <div className="cli-command-grid">
          <CommandSnippet command="mkdir printer-config" label="Create configuration folder" />
          <CommandSnippet command="cd printer-config" label="Enter configuration folder" />
        </div>
      </section>

      <section className="cli-command-card">
        <div className="cli-step-heading">
          <span>2</span>
          <div>
            <HelpRow label="Connect hlab and download the configuration" help={<>Install hlab with Klippee support, choose your operating system, then run the generated setup command in this folder.</>}><h3>Connect hlab and download the configuration</h3></HelpRow>
          </div>
        </div>
        <SegmentedControl aria-label="Desktop operating system" className="desktop-platform-picker" data={[{ label: "Windows", value: "windows" }, { label: "macOS / Linux", value: "unix" }]} onChange={(value) => setDesktopPlatform(value as "windows" | "unix")} value={desktopPlatform} />
        <HlabReleaseDownloads platform={desktopPlatform} />
        {desktopInstallCommand ? (
          <>
            <CommandSnippet command={desktopInstallCommand} label={`${desktopPlatform === "windows" ? "Windows" : "macOS / Linux"} setup`} />
            <p className="desktop-install-note">After setup completes, the current configuration is in this folder. Run <code>hlab klippee target</code> to confirm the connection.</p>
          </>
        ) : (
          <div className="sync-token-needed">
            <p>Create a private one-time credential for the selected operating system.</p>
            <Button className="primary-action" onClick={createDesktopSyncToken}>Generate setup command</Button>
          </div>
        )}
      </section>

      <section className="cli-command-card">
        <div className="cli-step-heading">
          <span>3</span>
          <div>
            <HelpRow label="Edit and sync your configuration" help={<>Run these commands from the same folder while working in your IDE.</>}><h3>Edit and sync your configuration</h3></HelpRow>
          </div>
        </div>
        <div className="desktop-sync-commands">
          <CommandSnippet command="hlab klippee check --diff" label="Review IDE changes" />
          <CommandSnippet command="hlab klippee capture --note &quot;Edited on desktop&quot;" label="Keep IDE changes" />
          <CommandSnippet command="hlab klippee apply" label="Use desired configuration" />
        </div>
        <p className="muted-line">Desktop apply creates a backup and never reports that the physical printer changed.</p>
      </section>
    </section>
  );
}
