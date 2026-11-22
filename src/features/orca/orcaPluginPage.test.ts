import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("plugins/orcaslicer/klippee_plugin.html", "utf8");

function page() {
  vi.useFakeTimers();
  document.body.innerHTML = html;
  let receive: (message: unknown) => void = () => {};
  const postMessage = vi.fn();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Plugin page has no script");
  new Function("document", "orca", script)(document, { postMessage, onMessage: (callback: typeof receive) => { receive = callback; } });
  return { receive: (message: unknown) => receive(message), postMessage };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.innerHTML = ""; });

describe("Orca plugin page recovery", () => {
  it("asks for state on load and recovers a save review and edited title", () => {
    const ui = page();
    expect(ui.postMessage).toHaveBeenCalledWith({ command: "ready" });
    ui.receive({ command: "state", busy: false, title: "My QIDI setup", view: {
      command: "connected", data: { printerName: "example1" }, origin: "https://klippee.xyz",
      selections: [{ kind: "machine", name: "example1", dirty: false }, { kind: "process", name: "Gridfinity", dirty: false }], nodes: 9, omittedKeys: [],
    } });
    expect(document.getElementById("preview")?.hidden).toBe(false);
    expect((document.getElementById("title") as HTMLInputElement).value).toBe("My QIDI setup");
    expect((document.getElementById("code") as HTMLInputElement).value).toBe("");
  });

  it("resumes polling after reload during restore and stops on completion", () => {
    const ui = page();
    ui.receive({ command: "state", busy: true, progress: "Writing preset copies…", title: "" });
    expect(document.getElementById("cancelOperation")?.hidden).toBe(false);
    expect((document.getElementById("restoreFile") as HTMLInputElement).disabled).toBe(true);
    vi.advanceTimersByTime(200);
    expect(ui.postMessage.mock.calls.filter(([message]) => message.command === "poll")).toHaveLength(2);
    ui.receive({ command: "restored", names: ["QIDI", "Process", "PLA", "PETG", "Clear", "PLA Basic"], nodes: 15 });
    expect(document.getElementById("restoreResult")?.hidden).toBe(false);
    expect((document.querySelector('[aria-label="Restored Filament 4"]') as HTMLInputElement).value).toBe("PLA Basic");
    expect(document.getElementById("cancelOperation")?.hidden).toBe(true);
    vi.advanceTimersByTime(200);
    expect(ui.postMessage.mock.calls.filter(([message]) => message.command === "poll")).toHaveLength(2);
  });
});
