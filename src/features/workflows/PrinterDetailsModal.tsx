import { Save } from "lucide-react";
import { Button, TextInput, Textarea } from "@mantine/core";
import { useRef } from "react";
import { usePrinterContext } from "../../app/contexts/usePrinterContext";
import { ModalShell } from "../../components/ModalShell";

export function PrinterDetailsModal() {
  const {
    printerDetailsDraft,
    printerDetailsEditorId,
    setPrinterDetailsDraft,
    closePrinterDetailsEditor,
    savePrinterDetails,
  } = usePrinterContext();
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  function updateField(field: "description" | "name", value: string) {
    setPrinterDetailsDraft((current) => ({ ...current, [field]: value }));
  }

  return (
    <ModalShell
      closeLabel="Close printer details"
      initialFocusRef={nameInputRef}
      onClose={closePrinterDetailsEditor}
      open={Boolean(printerDetailsEditorId)}
      sizeClass="printer-details-modal"
      title="Edit printer details"
    >
        <TextInput className="field" label="Name" data-autofocus
            onChange={(event) => updateField("name", event.target.value)}
            placeholder="Printer name"
            ref={nameInputRef}
            value={printerDetailsDraft.name}
          />
        <Textarea className="field" label="Description"
            onChange={(event) => updateField("description", event.target.value)}
            placeholder="Optional notes, location, hardware, or role"
            value={printerDetailsDraft.description}
          />
        <div className="modal-actions">
          <Button className="inline-action" onClick={closePrinterDetailsEditor} variant="subtle">
            Cancel
          </Button>
          <Button className="primary-action" leftSection={<Save size={18} />} onClick={savePrinterDetails}>Save details</Button>
        </div>
    </ModalShell>
  );
}
