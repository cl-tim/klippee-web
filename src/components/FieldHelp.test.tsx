import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithUi } from "../test/uiTestUtils";
import { FieldHelp } from "./FieldHelp";

describe("FieldHelp keyboard access", () => {
  it("opens with the keyboard, describes the help, and restores focus on Escape", async () => {
    renderWithUi(<FieldHelp label="Nozzle size">Choose the nozzle fitted to your printer.</FieldHelp>);
    const trigger = screen.getByRole("button", { name: "Help for Nozzle size" });
    await userEvent.tab();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const panel = await screen.findByRole("dialog", { name: "Help for Nozzle size" });
    expect(panel).toHaveAccessibleDescription("Choose the nozzle fitted to your printer.");
    await waitFor(() => expect(panel).toHaveFocus());
    await userEvent.tab();
    expect(panel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(panel).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.keyboard(" ");
    expect(await screen.findByRole("dialog", { name: "Help for Nozzle size" })).toBeVisible();
  });
});
