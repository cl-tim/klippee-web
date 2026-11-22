import { tabLabels } from "../../app/constants";
import { LoaderCircle, Plus, Printer, RefreshCw } from "lucide-react";
import { Badge, Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { usePrinterContext } from "../../app/contexts/usePrinterContext";
import { formatDate } from "../../app/format";
import { PageHeader } from "../../components/common";
import { PrinterSyncPanel } from "./PrinterSyncPanel";
import { PrinterPickerModal } from "./components/PrinterPickerModal";
import { SavedConfigurationsModal } from "./components/SavedConfigurationsModal";
import { summarizePrinterManagement } from "./printerManagement";

export function PrintersView() {
  const [managingConfigurations, setManagingConfigurations] = useState(false);
  const {
    printers,
    printerLoadFailed,
    selectedPrinterId,
    switchingPrinterId,
    addPrinterDraft,
    loadPrintersFromCloud,
    selectPrinter,
  } = usePrinterContext();

  return (
    <div className="panel printers-layout">
      <PageHeader
        actions={<Group gap="sm">
          <Button onClick={() => setManagingConfigurations(true)} variant="default">Saved configurations</Button>
          <Button className="primary-action" leftSection={<Plus size={18} />} onClick={addPrinterDraft} type="button">
          Add printer
          </Button>
        </Group>}
        className="span-all"
        help="Manage connection, configuration status, and integrations for each printer."
        title={tabLabels.Printers}
      />

      {printerLoadFailed ? (
        <Card className="workspace-operation-panel span-all" role="alert">
          <CardContent>
          <strong>Couldn't load printers from the cloud</strong>
          <Text>The list below may be incomplete or out of date.</Text>
          <div>
            <Button className="inline-action" leftSection={<RefreshCw size={15} />} onClick={() => void loadPrintersFromCloud()} variant="subtle">Retry</Button>
          </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="printer-management-shell">
        <aside className="printer-fleet" aria-label="Printer fleet">
          <div className="printer-fleet-heading">
            <div>
              <Text fw={600}>{printers.length} printer{printers.length === 1 ? "" : "s"}</Text>
            </div>
          </div>
          <div className="printer-fleet-list">
            {printers.map((printer) => {
              const summary = summarizePrinterManagement(printer);
              return (
                <article
                  className={printer.id === selectedPrinterId ? "printer-fleet-row is-selected" : "printer-fleet-row"}
                  key={printer.id}
                >
                  <UnstyledButton
                    aria-pressed={printer.id === selectedPrinterId}
                    className="printer-fleet-select"
                    disabled={Boolean(switchingPrinterId)}
                    onClick={() => selectPrinter(printer.id)}
                    style={{
                      backgroundColor: "transparent",
                      border: 0,
                      color: "inherit",
                      cursor: "pointer",
                      display: "grid",
                      gap: "8px 10px",
                      gridTemplateColumns: "auto minmax(0, 1fr)",
                      minWidth: 0,
                      padding: "11px",
                      textAlign: "left",
                      width: "100%",
                    }}
                    type="button"
                  >
                    <span className="printer-fleet-icon">
                      {switchingPrinterId === printer.id
                        ? <LoaderCircle className="is-spinning" size={18} />
                        : <Printer size={18} />}
                    </span>
                    <span className="printer-fleet-copy">
                      <strong>{printer.name}</strong>
                      {(printer.description || printer.make || printer.model) && <Text size="sm">{printer.description || [printer.make, printer.model].filter(Boolean).join(" ")}</Text>}
                      <Text size="sm">{printer.hostInfoUpdatedAt ? `Last report ${formatDate(printer.hostInfoUpdatedAt)}` : "No host report"}</Text>
                    </span>
                    <Badge className={`printer-state-badge is-${summary.tone}`} variant="light">{summary.configLabel}</Badge>
                  </UnstyledButton>
                </article>
              );
            })}
            {printers.length === 0 ? (
              <Stack className="printer-fleet-empty" align="center" gap="xs">
                <Printer size={24} />
                <strong>No printers yet</strong>
                <Text>Add a printer profile to start managing configuration.</Text>
              </Stack>
            ) : null}
          </div>
        </aside>

        <PrinterSyncPanel key={selectedPrinterId || "no-printer"} />
      </div>

      <PrinterPickerModal />
      <SavedConfigurationsModal open={managingConfigurations} onClose={() => setManagingConfigurations(false)} />
    </div>
  );
}
