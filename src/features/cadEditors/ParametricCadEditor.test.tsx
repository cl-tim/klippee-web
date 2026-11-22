import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParametricCadEditor } from "./ParametricCadEditor";
import { renderWithUi } from "../../test/uiTestUtils";

vi.mock("../openscad/OpenScadViewer", () => ({
  OpenScadViewer: () => <div aria-label="Mock CAD preview" />,
}));

function stlResponse() {
  return new Response(new Uint8Array(100), {
    headers: {
      "content-type": "model/stl",
      "x-cad-duration-ms": "125",
    },
    status: 200,
  });
}

describe("focused CAD editors", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads Gridfinity components and renders the selected parameters", async () => {
    const fetchMock = vi.fn(async () => stlResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderWithUi(<ParametricCadEditor kind="gridfinity" />);

    expect(screen.getByRole("heading", { level: 1, name: "Gridfinity Editor" })).toBeInTheDocument();
    expect(screen.getByText("5 pre-loaded SCAD files")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Lite bin/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Rows/i }), { target: { value: "3" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate preview" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init?.body)) as {
      files: Array<{ name: string }>;
      mainFile: string;
      parameters: Record<string, unknown>;
    };
    expect(payload.files.map((file) => file.name)).toEqual([
      "gridfinity-rebuilt-lite.scad",
      "gridfinity-rebuilt-utility.scad",
      "gridfinity-constants.scad",
    ]);
    expect(payload.mainFile).toBe("gridfinity-rebuilt-lite.scad");
    expect(payload.parameters).toMatchObject({
      divx: 2,
      divy: 3,
      gridx: 2,
      gridy: 2,
      gridz: 6,
      gridz_define: 0,
      length: 42,
      style_hole: 0,
      style_tab: 1,
    });
    expect(await screen.findByText(/Preview ready · 100 B/)).toBeInTheDocument();
  });

  it("maps Gridfinity baseplate style labels back to their upstream integers", async () => {
    const fetchMock = vi.fn(async () => stlResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderWithUi(<ParametricCadEditor kind="gridfinity" />);

    await userEvent.click(screen.getByRole("button", { name: /Baseplate/i }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Plate style/i }), "Weighted");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Screw holes/i }), "Counterbore");
    await userEvent.click(screen.getByRole("button", { name: "Generate preview" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init?.body)) as {
      files: Array<{ name: string }>;
      mainFile: string;
      parameters: Record<string, unknown>;
    };
    expect(payload.files.map((file) => file.name)).toEqual([
      "gridfinity-rebuilt-baseplate.scad",
      "gridfinity-rebuilt-utility.scad",
      "gridfinity-constants.scad",
    ]);
    expect(payload.mainFile).toBe("gridfinity-rebuilt-baseplate.scad");
    expect(payload.parameters).toMatchObject({
      enable_magnet: false,
      gridx: 4,
      gridy: 4,
      style_hole: 2,
      style_plate: 1,
    });
  });

  it("uses the supplied openGrid generator for Lite, Full, and fill-space tiles", async () => {
    const fetchMock = vi.fn(async () => stlResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderWithUi(<ParametricCadEditor kind="opengrid" />);

    expect(screen.getByRole("heading", { level: 1, name: "OpenGrid Editor" })).toBeInTheDocument();
    const components = within(screen.getByRole("navigation", { name: "OpenGrid Editor components" }));
    expect(components.getByRole("button", { name: /Lite tile/i })).toBeInTheDocument();
    expect(components.getByRole("button", { name: /Full tile/i })).toBeInTheDocument();
    expect(components.getByRole("button", { name: /Fill-space layout/i })).toBeInTheDocument();
    expect(screen.getByText("1 pre-loaded SCAD file")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Full tile/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Width/i }), { target: { value: "3" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate preview" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init?.body)) as {
      files: Array<{ name: string }>;
      mainFile: string;
      parameters: Record<string, unknown>;
    };
    expect(payload.files.map((file) => file.name)).toEqual(["openGrid.scad"]);
    expect(payload.mainFile).toBe("openGrid.scad");
    expect(payload.parameters).toMatchObject({
      Board_Width: 3,
      Fill_Space_Mode: "None",
      Full_or_Lite: "Full",
      Tile_Size: 28,
    });
  });

  it("loads the explored Underware 2.0 and Monokini component catalogue", () => {
    renderWithUi(<ParametricCadEditor kind="underware" />);

    expect(screen.getByRole("heading", { level: 1, name: "OpenGrid Underware Editor" })).toBeInTheDocument();
    expect(screen.getByText("32 pre-loaded SCAD files")).toBeInTheDocument();
    expect(screen.getAllByText(/Underware 2\.0/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Monokini/).length).toBeGreaterThan(0);
    const componentNavigation = screen.getByRole("navigation", { name: "OpenGrid Underware Editor components" });
    expect(within(componentNavigation).getByRole("button", { name: /Clamshell/i })).toBeInTheDocument();
    expect(within(componentNavigation).getByRole("button", { name: /Bridge/i })).toBeInTheDocument();
  });
});
