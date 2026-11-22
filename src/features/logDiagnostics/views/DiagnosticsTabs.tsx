import { Tabs } from "@mantine/core";
import type { ReactNode } from "react";

export type DiagnosticsTab<T extends string> = { icon: ReactNode; id: T; label: string };

/**
 * Mantine tab list, rendered inside the view's shared Tabs root so generated
 * tab and panel IDs, keyboard navigation, and selection stay paired.
 */
export function DiagnosticsTabs<T extends string>({ label, tabs, value }: {
  label: string;
  tabs: Array<DiagnosticsTab<T>>;
  value: T;
}) {
  return <Tabs.List aria-label={label} className="diagnostics-tabs">
    {tabs.map((tab) => {
      const active = tab.id === value;
      return <Tabs.Tab
        className={active ? "is-active" : ""}
        key={tab.id}
        leftSection={tab.icon}
        value={tab.id}
      >{tab.label}</Tabs.Tab>;
    })}
  </Tabs.List>;
}
