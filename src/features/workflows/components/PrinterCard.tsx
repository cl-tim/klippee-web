import { ArrowRight, Printer } from "lucide-react";
import { UnstyledButton } from "@mantine/core";
import { useAppShellContext } from "../../../app/contexts/useAppShellContext";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { SectionHeader } from "../../../components/common";

export function PrinterCard() {
  const { setActiveTab } = useAppShellContext();
  const { selectedPrinter, switchingPrinterId, printerStatus } = usePrinterContext();

  return (
    <section className={switchingPrinterId ? "slicer-printer-card is-switching" : "slicer-printer-card"}>
      <SectionHeader title="Current printer" />
      {printerStatus ? <span className="muted-line">{printerStatus}</span> : null}
      {selectedPrinter ? (
        <div className="printer-summary-row">
          <Printer aria-hidden="true" size={19} />
          <div className="printer-summary-copy">
            <strong>{selectedPrinter.name}</strong>
            {selectedPrinter.description && <span className="muted-line">{selectedPrinter.description}</span>}
          </div>
        </div>
      ) : <p className="muted-line">Choose a printer before opening its workspace.</p>}
      <UnstyledButton
        aria-label={selectedPrinter ? "Manage or switch printer" : "Choose a printer"}
        className="inline-action printer-manage-link"
        onClick={() => setActiveTab("Printers")}
        style={{
          alignItems: "center",
          backgroundColor: "transparent",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
          cursor: "pointer",
          display: "flex",
          fontSize: "var(--text-secondary)",
          gap: 8,
          justifyContent: "space-between",
          minHeight: "var(--control-height-sm)",
          padding: "6px 11px",
          textAlign: "left",
          width: "100%",
        }}
      >
        <span className="printer-manage-label-full">{selectedPrinter ? "Manage or switch printer" : "Choose a printer"}</span>
        <span className="printer-manage-label-short">{selectedPrinter ? "Manage" : "Choose"}</span>
        <ArrowRight size={15} />
      </UnstyledButton>
    </section>
  );
}
