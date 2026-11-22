import { ActionIcon, Menu } from "@mantine/core";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";

export function MoreActions({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  return <Menu position="bottom-end" shadow="md" width={240} zIndex={350}>
    <Menu.Target><ActionIcon aria-label={label} title={label} type="button" size={44} variant="subtle" disabled={disabled}>
      <Ellipsis aria-hidden="true" size={20} />
    </ActionIcon></Menu.Target>
    <Menu.Dropdown>{children}</Menu.Dropdown>
  </Menu>;
}
