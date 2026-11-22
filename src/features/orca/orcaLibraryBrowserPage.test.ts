import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import page from "../../../plugins/orcaslicer/klippee_plugin.html?raw";

describe("Orca plugin library browser", () => {
  it("searches and filters profiles, reviews the chosen identity, and distinguishes individual restore instructions", () => {
    document.body.innerHTML = page;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
    let receive: (message: unknown) => void = () => {};
    const postMessage = vi.fn();
    const script = document.querySelector("script")!.textContent!;
    new Function("orca", script)({ postMessage, onMessage: (handler: typeof receive) => { receive = handler; } });
    receive({ command: "library_listed", origin: "https://klippee.xyz", library: { id: "import", expiresAt: "2099-01-01T00:00:00Z", profiles: [
      { id: "machine:example1 0.2mm", name: "example1 0.2mm", kind: "machine", nozzle: "0.2", parent: "QIDI base" },
      { id: "filament:Custom PETG", name: "Custom PETG", kind: "filament", parent: "PETG base" },
    ] } });
    expect(screen.getByRole("region", { name: "Klippee library" })).toBeVisible();
    receive({ command: "library_listed", origin: "https://klippee.xyz", library: { id: "import", expiresAt: null, profiles: [
      { id: "machine:example1 0.2mm", name: "example1 0.2mm", kind: "machine", nozzle: "0.2", parent: "QIDI base" },
      { id: "filament:Custom PETG", name: "Custom PETG", kind: "filament", parent: "PETG base" },
    ] } });
    expect(screen.getByText(/Connected on this computer/)).toBeVisible();
    expect(screen.getByLabelText("Library access code")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review current setup" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "review_saved_setup" });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "save" }));
    receive({ command: "error", error: "Enable uploads first" });
    fireEvent.change(screen.getByLabelText("Profile type"), { target: { value: "filament" } });
    expect(screen.getByText("1 of 2 saved profiles")).toBeVisible();
    expect(screen.queryByRole("option", { name: "Printer profile: example1 0.2mm" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review selected profile" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "review_library_profile", profileId: "filament:Custom PETG" });
    receive({ command: "restored", profile: true, kinds: ["filament"], names: ["copied Custom PETG"], nodes: 3 });
    expect(screen.getByText(/Profile and its full inheritance restored and verified/)).toBeVisible();
    expect(screen.getByLabelText("Restored Filament")).toHaveValue("copied Custom PETG");
    fireEvent.input(screen.getByLabelText("Search saved profiles"), { target: { value: "missing" } });
    expect(screen.getByText("0 of 2 saved profiles")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review selected profile" })).toBeDisabled();
  });
});
