import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { maxJsonBodyBytes } from "../worker/constants";
import { readJsonBody } from "../worker/http";
import { fetchState, jsonResponse, setAccountStored, stubApiRoutes, workspaceTestPrinter } from "./test/appTestUtils";

describe("printer settings cloud persistence", () => {
  it.each([0, maxJsonBodyBytes])("persists a description with %i bytes of local workspace", async (workspaceBytes) => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    let cloudPrinter = { ...workspaceTestPrinter(), description: "Voron with Eddy Duo" };
    const description = "Voron with Beacon and Phaetus neXt G with PT1000";
    setAccountStored("printers", [{
      ...cloudPrinter,
      workspaceDrafts: { "printer.cfg": "#".repeat(workspaceBytes) },
    }]);
    setAccountStored("selectedPrinterId", cloudPrinter.id);
    window.history.replaceState(null, "", "/printers");
    let saveRequests = 0;
    stubApiRoutes(async (url, init) => {
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers") && init?.method === "POST") {
        saveRequests += 1;
        // Exercise the Worker's actual request-size guard.
        const parsed = await readJsonBody<{ printer: typeof cloudPrinter }>(
          new Request("https://klippee.test/api/printers", init),
        );
        if (!parsed.ok) return parsed.response;
        cloudPrinter = { ...cloudPrinter, description: parsed.value.printer.description };
        return jsonResponse({ printer: cloudPrinter });
      }
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [cloudPrinter] });
    });

    const first = render(<StrictMode><App /></StrictMode>);
    await userEvent.click((await screen.findAllByText("Printer details")).find(element => element.tagName === "SPAN")!);
    await userEvent.clear(screen.getByRole("textbox", { name: "Description", exact: true }));
    await userEvent.type(screen.getByRole("textbox", { name: "Description", exact: true }), description);
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(saveRequests).toBe(1));
    await waitFor(() => expect(cloudPrinter.description).toBe(description));
    first.unmount();

    render(<StrictMode><App /></StrictMode>);
    await userEvent.click((await screen.findAllByText("Printer details")).find(element => element.tagName === "SPAN")!);
    expect(await screen.findByRole("textbox", { name: "Description", exact: true })).toHaveValue(description);
  });

  it("reports a failed cloud save and lets the owner retry the same details", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    const printer = workspaceTestPrinter();
    setAccountStored("printers", [printer]);
    setAccountStored("selectedPrinterId", printer.id);
    window.history.replaceState(null, "", "/printers");
    let finishSave: ((response: Response) => void) | undefined;
    let saveRequests = 0;
    stubApiRoutes((url, init) => {
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.endsWith("/api/printers") && init?.method === "POST") {
        saveRequests += 1;
        if (saveRequests === 1) return new Promise<Response>(resolve => { finishSave = resolve; });
        return jsonResponse({ printer });
      }
      if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
    });
    render(<StrictMode><App /></StrictMode>);
    await userEvent.click((await screen.findAllByText("Printer details")).find(element => element.tagName === "SPAN")!);
    await userEvent.type(screen.getByRole("textbox", { name: "Description", exact: true }), " with Beacon");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(saveRequests).toBe(1));
    expect(screen.getByRole("button", { name: "Saving details…" })).toBeDisabled();
    await act(async () => { finishSave?.(jsonResponse({ error: "Service unavailable" }, 503)); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save printer details");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(saveRequests).toBe(2));
    expect(await screen.findByRole("status")).toHaveTextContent("Printer details saved");
  });
});
