from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any

from server.cad_geometry import CadConversionError, apply_reconstruction_parameters


def build_build123d_model(plan: dict[str, Any], workspace: Path) -> Any:
    import build123d as b3d

    parts = []
    for body in plan["bodies"]:
        parameters = body["parameters"]
        origin = (parameters["x"], parameters["y"], parameters["z"])
        kind = body["kind"]
        if kind == "box":
            part = b3d.Solid.make_box(
                parameters["width"],
                parameters["depth"],
                parameters["height"],
                b3d.Plane(origin=origin),
            )
        elif kind in ("cylinder", "tube"):
            plane = b3d.Plane(origin=origin, z_dir=body["direction"])
            part = b3d.Solid.make_cylinder(parameters["radius"], parameters["height"], plane)
            if kind == "tube":
                bore = b3d.Solid.make_cylinder(parameters["bore_radius"], parameters["height"], plane)
                part = part.cut(bore)
        elif kind == "linear_extrusion":
            width_scale = parameters["width"] / body["profileWidth"]
            depth_scale = parameters["depth"] / body["profileDepth"]
            solids = []
            for triangle in body["profileTriangles"]:
                points = []
                for point in triangle:
                    points.append(
                        tuple(
                            origin[coordinate]
                            + body["xDirection"][coordinate] * point[0] * width_scale
                            + body["yDirection"][coordinate] * point[1] * depth_scale
                            for coordinate in range(3)
                        )
                    )
                face = b3d.Face(b3d.Wire.make_polygon(points, close=True))
                solids.append(
                    b3d.Solid.extrude(
                        face,
                        tuple(value * parameters["height"] for value in body["direction"]),
                    )
                )
            part = b3d.Compound(solids)
        else:
            bounds = body["bounds"]
            minimum = bounds["minimum"]
            size = bounds["size"]
            reference_path = workspace / f"reference-{body['index']:03d}.brep"
            reference_path.write_bytes(base64.b64decode(body["brep"], validate=True))
            part = b3d.import_brep(reference_path)
            part = part.transform_geometry(
                b3d.Matrix(
                    [
                        [parameters["width"] / size[0], 0, 0, parameters["x"] - minimum[0] * parameters["width"] / size[0]],
                        [0, parameters["depth"] / size[1], 0, parameters["y"] - minimum[1] * parameters["depth"] / size[1]],
                        [0, 0, parameters["height"] / size[2], parameters["z"] - minimum[2] * parameters["height"] / size[2]],
                    ]
                )
            )

        visible = plan["showReferenceParts"] if kind == "reference" else plan["showRecognizedParts"]
        if visible:
            parts.append(part)

    if not parts:
        raise CadConversionError("build123d reconstruction has no visible bodies.")
    return b3d.Compound(parts)


def render_build123d_payload(payload: object, output_path: Path, mode: str) -> None:
    if not isinstance(payload, dict):
        raise CadConversionError("Expected a build123d render request.")
    plan = payload.get("plan")
    parameters = payload.get("parameters", {})
    if not isinstance(plan, dict):
        raise CadConversionError("build123d render requests need a reconstruction plan.")

    updated_plan = apply_reconstruction_parameters(plan, parameters)
    import build123d as b3d

    result = build_build123d_model(updated_plan, output_path.parent)
    tolerance = 0.15 if mode == "preview" else 0.05
    angular_tolerance = 0.25 if mode == "preview" else 0.1
    if not b3d.export_stl(
        result,
        output_path,
        tolerance=tolerance,
        angular_tolerance=angular_tolerance,
    ):
        raise CadConversionError("build123d could not export the STL.")
    if not output_path.exists() or output_path.stat().st_size < 84:
        raise CadConversionError("build123d returned an empty STL.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a validated Klippee build123d reconstruction plan.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--mode", choices=("preview", "export"), default="preview")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        render_build123d_payload(payload, args.output, args.mode)
    except (CadConversionError, json.JSONDecodeError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
