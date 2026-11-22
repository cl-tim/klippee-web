import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountStorageProvider } from "../../app/contexts/AccountStorageContext";
import { OpenScadView } from "./OpenScadView";
import { renderWithUi } from "../../test/uiTestUtils";

vi.mock("./OpenScadViewer", () => ({
  OpenScadViewer: () => <div aria-label="Mock CAD preview" />,
}));

async function renderOpenScadView() {
  const result = renderWithUi(
    <AccountStorageProvider userId={null}>
      <OpenScadView />
    </AccountStorageProvider>,
  );
  await screen.findByLabelText("CAD source panel");
  return result;
}

describe("OpenSCAD workspace panels", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("starts with equal thirds and exposes keyboard-resizable dividers", async () => {
    await renderOpenScadView();

    const workspace = screen.getByLabelText("CAD source panel").parentElement;
    const sourceDivider = screen.getByRole("separator", { name: "Resize source and preview panels" });

    expect(workspace).toHaveStyle({
      "--openscad-parameters-ratio": "1fr",
      "--openscad-source-ratio": "1fr",
      "--openscad-viewer-ratio": "1fr",
    });
    expect(sourceDivider).toHaveAttribute("aria-valuenow", "33");

    fireEvent.keyDown(sourceDivider, { key: "ArrowRight" });
    expect(sourceDivider).toHaveAttribute("aria-valuenow", "37");
    expect(workspace).not.toHaveStyle({ "--openscad-source-ratio": "1fr" });

    await waitFor(() => {
      expect(localStorage.getItem("klippee.openscad.panel-layout.v1")).not.toBe("[1,1,1]");
    });

    fireEvent.keyDown(sourceDivider, { key: "Home" });
    expect(sourceDivider).toHaveAttribute("aria-valuenow", "33");
    expect(workspace).toHaveStyle({
      "--openscad-parameters-ratio": "1fr",
      "--openscad-source-ratio": "1fr",
      "--openscad-viewer-ratio": "1fr",
    });
    expect(screen.getByRole("combobox", { name: "Entry file" })).toHaveValue("model.scad");
    expect(screen.queryByText("Starter template")).not.toBeInTheDocument();
  });

  it("imports dropped SCAD files and makes the first one active", async () => {
    await renderOpenScadView();

    const sourcePanel = screen.getByLabelText("CAD source panel");
    const droppedFile = new File(["width = 24;\ncube(width);"], "dropped-part.scad", { type: "text/plain" });
    const helperFile = new File(["module helper() { sphere(4); }"], "helper.scad", { type: "text/plain" });
    const dataTransfer = {
      dropEffect: "none",
      files: [droppedFile, helperFile],
      types: ["Files"],
    };

    fireEvent.dragEnter(sourcePanel, { dataTransfer });
    expect(screen.getByRole("status", { name: "Drop OpenSCAD files here" })).toBeVisible();

    fireEvent.dragOver(sourcePanel, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");

    fireEvent.drop(sourcePanel, { dataTransfer });

    const entryFile = screen.getByRole("combobox", { name: "Entry file" });
    await waitFor(() => expect(entryFile).toHaveValue("dropped-part.scad"));
    expect(within(entryFile).getByRole("option", { name: "helper.scad" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Source/i })).toHaveValue("width = 24;\ncube(width);");
    expect(screen.getByText("Loaded 2 OpenSCAD files")).toBeVisible();
    expect(screen.queryByRole("status", { name: "Drop OpenSCAD files here" })).not.toBeInTheDocument();
    fireEvent.change(entryFile, { target: { value: "helper.scad" } });
    expect(screen.getByRole("textbox", { name: /Source/i })).toHaveValue("module helper() { sphere(4); }");
  });

  it("explains when a drop contains no SCAD files", async () => {
    await renderOpenScadView();

    fireEvent.drop(screen.getByLabelText("CAD source panel"), {
      dataTransfer: {
        files: [new File(["notes"], "README.txt", { type: "text/plain" })],
        types: ["Files"],
      },
    });

    expect(await screen.findByText("No OpenSCAD files found. Add one or more files ending in .scad.")).toBeVisible();
  });

  it("keeps build123d as a separate reconstruction and render target", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        bodyCount: 1,
        duration: 150,
        engine: "build123d",
        parameters: [{
          defaultValue: 10,
          group: "Body 01",
          key: "body_01_width",
          label: "Width",
          type: "number",
        }],
        plan: { bodies: [], version: 1 },
        recognizedBodyCount: 1,
        referenceBodyCount: 0,
        source: "import build123d as b3d\nbody_01_width = 10",
        triangleCount: 12,
        vertexCount: 8,
      }), { headers: { "content-type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(100), {
        headers: { "content-type": "model/stl", "x-cad-duration-ms": "42" },
        status: 200,
      }));
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenScadView();

    expect(within(screen.getByRole("combobox", { name: "Reconstruction output" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["OpenSCAD", "build123d"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Reconstruction output" }), {
      target: { value: "build123d" },
    });
    const upload = screen.getByLabelText("Reverse-engineer STEP, IGES, or BREP as build123d");
    expect(upload).not.toBeNull();
    fireEvent.change(upload!, {
      target: { files: [new File(["step-data"], "sample.step", { type: "application/step" })] },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("target=build123d"),
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByRole("combobox", { name: "Entry file" })).toHaveValue("sample.build123d.py");
    expect(screen.getByText("Source — generated build123d")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/cad/render-build123d?mode=preview",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
