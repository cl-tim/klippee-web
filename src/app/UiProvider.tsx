import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import "@mantine/core/styles.css";
import { uiCssVariables, uiTheme } from "./uiTheme";

export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider
      cssVariablesResolver={uiCssVariables}
      env={import.meta.env.MODE === "test" ? "test" : "default"}
      forceColorScheme="dark"
      theme={uiTheme}
    >
      {children}
    </MantineProvider>
  );
}
