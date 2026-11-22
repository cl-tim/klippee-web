import { ActionIcon, Popover, Text } from "@mantine/core";
import { CircleHelp } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const descriptionId = useId();
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" width={320} withinPortal={false} trapFocus returnFocus shadow="md">
    <Popover.Target>
      <ActionIcon type="button" variant="subtle" color="gray" size={44} style={{ flexShrink: 0 }}
        aria-label={`Help for ${label}`} data-mantine-stop-propagation={opened || undefined}
        onKeyDown={event => { if (opened && event.key === "Escape") { event.stopPropagation(); setOpened(false); } }}
        onClick={() => setOpened(current => !current)}>
        <CircleHelp aria-hidden="true" size={18} />
      </ActionIcon>
    </Popover.Target>
    <Popover.Dropdown aria-label={`Help for ${label}`} aria-describedby={descriptionId} data-mantine-stop-propagation="true"
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
      style={{ maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 32px)", overflowY: "auto" }}>
      <Text id={descriptionId} size="sm">{children}</Text>
    </Popover.Dropdown>
  </Popover>;
}

export function FieldLabel({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return <HelpRow label={label} help={children}>
    <Text component="label" htmlFor={htmlFor} size="sm" fw={500}>{label}</Text>
  </HelpRow>;
}

export function HelpRow({ label, help, children }: { label: string; help: ReactNode; children: ReactNode }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minWidth: 0 }}>
    {children}
    <FieldHelp label={label}>{help}</FieldHelp>
  </div>;
}
