import { ArrowLeft, Printer } from "lucide-react";
import { Button, TextInput, Textarea, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { ModalShell } from "../../../components/ModalShell";
import { orcaPrinterCatalog, type PrinterCatalogOption } from "../../../orcaPrinterCatalog";

export function PrinterPickerModal() {
  const { printerPickerOpen, setPrinterPickerOpen, startPrinterDraftFromCatalog } = usePrinterContext();
  const [selectedOption, setSelectedOption] = useState<PrinterCatalogOption | null>(null);
  const [printerName, setPrinterName] = useState("");
  const [printerDescription, setPrinterDescription] = useState("");

  function reset() {
    setSelectedOption(null);
    setPrinterName("");
    setPrinterDescription("");
  }

  function close() {
    reset();
    setPrinterPickerOpen(false);
  }

  function chooseOption(option: PrinterCatalogOption) {
    setSelectedOption(option);
    setPrinterName(option.source === "custom" ? "" : option.name);
    setPrinterDescription("");
  }

  function createPrinter() {
    if (!selectedOption || !printerName.trim()) {
      return;
    }
    const option = selectedOption;
    const details = { description: printerDescription, name: printerName };
    reset();
    startPrinterDraftFromCatalog(option, details);
  }

  return (
    <ModalShell
      closeLabel="Close printer picker"
      onClose={close}
      open={printerPickerOpen}
      sizeClass="printer-picker-modal"
      title={selectedOption ? "Name your printer" : "Choose a starting point"}
    >
        {selectedOption ? (
          <div className="printer-picker-confirm">
            <Button className="inline-action printer-picker-back" leftSection={<ArrowLeft size={16} />} onClick={() => setSelectedOption(null)} variant="subtle">Choose another starter</Button>
            <div className="printer-picker-selection">
              <Printer size={22} />
              <div>
                <strong>{selectedOption.name}</strong>
                <span>
                  {selectedOption.source === "custom"
                    ? "Starts with an empty configuration workspace."
                    : "Includes editable example configuration files and placeholders."}
                </span>
              </div>
            </div>
            <TextInput className="field" label="Printer name" description="Required"
                autoFocus
                onChange={(event) => setPrinterName(event.target.value)}
                placeholder="Workshop printer"
                value={printerName}
              />
            <Textarea className="field" label="Description" description="Optional"
                onChange={(event) => setPrinterDescription(event.target.value)}
                placeholder="Location, hardware, or role"
                value={printerDescription}
              />
            <div className="modal-actions">
              <Button className="inline-action" onClick={close} variant="subtle">Cancel</Button>
              <Button className="primary-action" disabled={!printerName.trim()} onClick={createPrinter}>Add printer</Button>
            </div>
          </div>
        ) : (
          <div className="printer-picker-grid">
            {orcaPrinterCatalog.map((option) => (
              <UnstyledButton
                className={option.source === "custom" ? "printer-picker-option is-custom" : "printer-picker-option"}
                key={option.id}
                onClick={() => chooseOption(option)}
                style={{
                  alignItems: "flex-start",
                  backgroundColor: "var(--card)",
                  border: `1px solid ${option.source === "custom" ? "var(--accent-strong)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 14,
                  textAlign: "left",
                }}
                type="button"
              >
                <Printer size={20} />
                <div>
                  <strong>{option.name}</strong>
                  <span>{option.source === "custom" ? "Empty workspace" : "Editable starter configuration"}</span>
                </div>
                <small>{option.tags.slice(0, 3).join(", ")}</small>
              </UnstyledButton>
            ))}
          </div>
        )}
    </ModalShell>
  );
}
