import { Modal, Stack } from "@mantine/core";
import { useEffect, type ReactNode, type RefObject } from "react";
import { HelpRow } from "./FieldHelp";

const dialogWidths: Record<string, number> = {
  "login-modal": 420,
  "printer-details-modal": 480,
  "confirm-modal": 440,
  "install-modal": 620,
  "registry-publisher-modal": 1040,
  "workspace-recovery-modal": 900,
  "printer-picker-modal": 700,
};

export function ModalShell({ children, closeLabel = "Close dialog", help, initialFocusRef, onClose, open, sizeClass, title, busy = false }: {
  children: ReactNode; closeLabel?: string; help?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>; onClose: () => void; open: boolean; sizeClass?: string; title: ReactNode;
  busy?: boolean;
}) {
  useEffect(() => {
    if (!open || !initialFocusRef) return;
    const timer = window.setTimeout(() => initialFocusRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, initialFocusRef]);

  return (
    <Modal.Root opened={open} onClose={onClose} closeOnEscape={!busy} closeOnClickOutside={!busy} centered size={dialogWidths[sizeClass ?? ""] ?? "xl"} padding="lg" zIndex={200} returnFocus trapFocus>
      <Modal.Overlay backgroundOpacity={0.65} blur={3} />
      <Modal.Content className={sizeClass}>
        <Modal.Header className="modal-header" style={{ alignItems: "flex-start", gap: 8 }}>
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            {help ? <HelpRow label={typeof title === "string" ? title : closeLabel} help={help}>
              <Modal.Title style={{ fontSize: "1.5rem", lineHeight: 1.3, fontWeight: 650 }}>{title}</Modal.Title>
            </HelpRow> : <Modal.Title style={{ fontSize: "1.5rem", lineHeight: 1.3, fontWeight: 650 }}>{title}</Modal.Title>}
          </Stack>
          <Modal.CloseButton aria-label={closeLabel} disabled={busy} size="lg" style={{ flexShrink: 0, marginTop: 0 }} />
        </Modal.Header>
        <Modal.Body><Stack gap="md">{children}</Stack></Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
