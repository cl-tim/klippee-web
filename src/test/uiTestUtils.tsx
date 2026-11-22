import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { UiProvider } from "../app/UiProvider";

export function TestUiProvider({ children }: { children: ReactNode }) {
  return <UiProvider>{children}</UiProvider>;
}

export function renderWithUi(ui: ReactElement, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <TestUiProvider>{Wrapper ? <Wrapper>{children}</Wrapper> : children}</TestUiProvider>
    ),
  });
}
