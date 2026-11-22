from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import asyncio
import copy
import math
import sys
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

from server.cad_app import (
    MAX_SCAD_FILES,
    app,
    parameter_definition,
    read_limited_body,
    run_process,
    safe_scad_path,
    validate_scad_source,
)
from server.build123d_runner import build_build123d_model, render_build123d_payload
from server.cad_geometry import (
    CadConversionError,
    apply_reconstruction_parameters,
    convert_cad_file,
    validate_reconstruction_plan,
)


class CadConversionTests(unittest.TestCase):
    def write_step(self, path: Path, shape) -> None:
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        self.assertEqual(writer.Write(str(path)), IFSelect_RetDone)

    def test_reconstructs_box_as_editable_scad(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "box.step"
            self.write_step(path, BRepPrimAPI_MakeBox(10, 20, 30).Shape())

            result = convert_cad_file(path, "step", "box.step")

        self.assertEqual(result["bodyCount"], 1)
        self.assertEqual(result["recognizedBodyCount"], 1)
        self.assertEqual(result["referenceBodyCount"], 0)
        self.assertIn("module body_01()", result["source"])
        self.assertIn("cube([body_01_width, body_01_depth, body_01_height])", result["source"])
        self.assertNotIn("reference_mesh_01", result["source"])

    def test_reconstructs_cylinder_and_tube_as_native_scad(self) -> None:
        with TemporaryDirectory() as temporary:
            cylinder_path = Path(temporary) / "cylinder.step"
            tube_path = Path(temporary) / "tube.step"
            self.write_step(cylinder_path, BRepPrimAPI_MakeCylinder(4, 20).Shape())
            tube = BRepAlgoAPI_Cut(
                BRepPrimAPI_MakeCylinder(6, 20).Shape(),
                BRepPrimAPI_MakeCylinder(3, 20).Shape(),
            ).Shape()
            self.write_step(tube_path, tube)

            cylinder_result = convert_cad_file(cylinder_path, "step", "cylinder.step")
            tube_result = convert_cad_file(tube_path, "step", "tube.step")

        self.assertEqual(cylinder_result["features"][0]["type"], "cylinder")
        self.assertIn("r=body_01_radius", cylinder_result["source"])
        self.assertEqual(tube_result["features"][0]["type"], "tube")
        self.assertIn("body_01_bore_radius", tube_result["source"])

    def test_reconstructs_oriented_prism_as_linear_extrusion(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "oriented.step"
            transform = gp_Trsf()
            transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(17))
            shape = BRepBuilderAPI_Transform(BRepPrimAPI_MakeBox(10, 20, 3).Shape(), transform, True).Shape()
            self.write_step(path, shape)

            result = convert_cad_file(path, "step", "oriented.step")

        self.assertEqual(result["recognizedBodyCount"], 1)
        self.assertEqual(result["features"][0]["type"], "linear_extrusion")
        self.assertIn("linear_extrude(height=body_01_height)", result["source"])
        self.assertIn("module body_01_profile()", result["source"])

    def test_marks_unrecognized_geometry_as_adjustable_reference(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "sphere.step"
            self.write_step(path, BRepPrimAPI_MakeSphere(5).Shape())

            result = convert_cad_file(path, "step", "sphere.step")

        self.assertEqual(result["recognizedBodyCount"], 0)
        self.assertEqual(result["referenceBodyCount"], 1)
        self.assertEqual(result["features"][0]["confidence"], "reference")
        self.assertIn("module reference_mesh_01()", result["source"])

    def test_reconstructs_box_as_parameterized_build123d(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "box.step"
            self.write_step(path, BRepPrimAPI_MakeBox(10, 20, 30).Shape())

            result = convert_cad_file(path, "step", "box.step", "build123d")

        self.assertEqual(result["engine"], "build123d")
        self.assertEqual(result["plan"]["bodies"][0]["kind"], "box")
        self.assertIn("import build123d as b3d", result["source"])
        self.assertIn("b3d.Solid.make_box", result["source"])
        self.assertIn("body_01_width", {parameter["key"] for parameter in result["parameters"]})

    def test_preserves_unrecognized_body_as_build123d_brep_reference(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "sphere.step"
            self.write_step(path, BRepPrimAPI_MakeSphere(5).Shape())

            result = convert_cad_file(path, "step", "sphere.step", "build123d")
            model = build_build123d_model(result["plan"], Path(temporary))
            # Affine reference transforms produce splines; integrate adaptively
            # rather than using the kernel's coarse default volume estimate.
            properties = GProp_GProps()
            BRepGProp.VolumeProperties_s(model.wrapped, properties, 1e-8)
            self.assertAlmostEqual(properties.Mass(), 4 * math.pi * 5 ** 3 / 3, places=3)

        body = result["plan"]["bodies"][0]
        self.assertEqual(body["kind"], "reference")
        self.assertGreater(len(body["brep"]), 100)
        self.assertIn("import_brep_data", result["source"])

    def test_build123d_reconstructs_cylinders_tubes_and_oriented_profiles(self) -> None:
        transform = gp_Trsf()
        transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(17))
        cases = (
            ("cylinder", BRepPrimAPI_MakeCylinder(4, 20).Shape(), math.pi * 4 ** 2 * 20),
            ("tube", BRepAlgoAPI_Cut(
                BRepPrimAPI_MakeCylinder(6, 20).Shape(),
                BRepPrimAPI_MakeCylinder(3, 20).Shape(),
            ).Shape(), math.pi * (6 ** 2 - 3 ** 2) * 20),
            ("linear_extrusion", BRepBuilderAPI_Transform(
                BRepPrimAPI_MakeBox(10, 20, 3).Shape(), transform, True,
            ).Shape(), 600),
        )
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for kind, shape, volume in cases:
                with self.subTest(kind=kind):
                    path = root / f"{kind}.step"
                    self.write_step(path, shape)
                    result = convert_cad_file(path, "step", path.name, "build123d")
                    self.assertEqual(result["plan"]["bodies"][0]["kind"], kind)
                    model = build_build123d_model(result["plan"], root)
                    self.assertAlmostEqual(model.volume, volume, places=3)

    def test_validates_and_applies_only_known_reconstruction_parameters(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "box.step"
            self.write_step(path, BRepPrimAPI_MakeBox(10, 20, 30).Shape())
            plan = convert_cad_file(path, "step", "box.step", "build123d")["plan"]

        self.assertIs(validate_reconstruction_plan(plan), plan)
        updated = apply_reconstruction_parameters(plan, {"body_01_width": 42, "show_reference_parts": False})
        self.assertEqual(updated["bodies"][0]["parameters"]["width"], 42)
        self.assertFalse(updated["showReferenceParts"])
        self.assertAlmostEqual(plan["bodies"][0]["parameters"]["width"], 10, places=4)
        with self.assertRaisesRegex(CadConversionError, "Unknown CAD parameter"):
            apply_reconstruction_parameters(plan, {"__import__": "os"})
        with self.assertRaisesRegex(CadConversionError, "must be positive"):
            apply_reconstruction_parameters(plan, {"body_01_width": -1})
        injected = copy.deepcopy(plan)
        injected["sourceName"] = "model\n__import__('os').system('whoami')"
        with self.assertRaisesRegex(CadConversionError, "Invalid CAD source name"):
            validate_reconstruction_plan(injected)

    def test_rejects_unknown_reconstruction_target_before_parsing(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "box.step"
            path.write_bytes(b"not cad")
            for target in ("python", "cadquery"):
                with self.subTest(target=target), self.assertRaisesRegex(CadConversionError, "Unsupported reconstruction target"):
                    convert_cad_file(path, "step", "box.step", target)

    def test_renders_build123d_plan_without_executing_submitted_source(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "box.step"
            output = root / "box.stl"
            self.write_step(path, BRepPrimAPI_MakeBox(10, 20, 30).Shape())
            result = convert_cad_file(path, "step", "box.step", "build123d")

            render_build123d_payload(
                {
                    "parameters": {"body_01_width": 42},
                    "plan": result["plan"],
                    "source": "raise RuntimeError('must never execute')",
                },
                output,
                "preview",
            )

            self.assertGreater(output.stat().st_size, 84)

    def test_rejects_unknown_format(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "box.unknown"
            path.write_bytes(b"not cad")
            with self.assertRaisesRegex(ValueError, "Unsupported CAD format"):
                convert_cad_file(path, "unknown", "box.unknown")


class CadRequestValidationTests(unittest.TestCase):
    def test_streams_request_body_and_stops_at_the_size_limit(self) -> None:
        class StreamingRequest:
            headers: dict[str, str] = {}

            async def stream(self):
                yield b"1234"
                yield b"5"

            async def body(self):
                raise AssertionError("read_limited_body must not pre-buffer the request")

        with patch("server.cad_app.MAX_CAD_BODY_BYTES", 4):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(read_limited_body(StreamingRequest()))  # type: ignore[arg-type]

        self.assertEqual(raised.exception.status_code, 413)
        self.assertIn("too large", raised.exception.detail)

    def test_caps_subprocess_diagnostic_output(self) -> None:
        with TemporaryDirectory() as temporary:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    run_process(
                        sys.executable,
                        "-c",
                        "import sys; sys.stdout.write('x' * 2048)",
                        cwd=Path(temporary),
                        output_limit=1024,
                    )
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertIn("diagnostic output", raised.exception.detail)

    def test_stops_subprocess_when_generated_artifact_exceeds_limit(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "oversized.stl"
            script = (
                "from pathlib import Path; import sys, time; "
                "Path(sys.argv[1]).write_bytes(b'x' * 2048); time.sleep(2)"
            )
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    run_process(
                        sys.executable,
                        "-c",
                        script,
                        str(artifact),
                        cwd=root,
                        timeout=5,
                        artifact_limits=((artifact, 1024),),
                    )
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertIn("artifact", raised.exception.detail)

    def test_rejects_more_than_sixty_four_scad_files(self) -> None:
        self.assertEqual(MAX_SCAD_FILES, 64)
        response = TestClient(app).post(
            "/api/render",
            json={
                "files": [
                    {"name": f"part-{index}.scad", "source": "cube(1);"}
                    for index in range(MAX_SCAD_FILES + 1)
                ],
                "mainFile": "part-0.scad",
                "parameters": {},
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("between 1 and 64", response.json()["detail"])

    def test_health_promises_no_storage(self) -> None:
        response = TestClient(app).get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["storage"], "none")
        self.assertEqual(response.json()["engines"]["build123dRender"], "build123d")
        self.assertNotIn("cadQueryRender", response.json()["engines"])
        self.assertIn("BOSL2", response.json()["scadLibraries"])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_rejects_the_removed_cadquery_api(self) -> None:
        client = TestClient(app)
        self.assertEqual(client.post("/api/render-cadquery", json={}).status_code, 404)
        response = client.post(
            "/api/convert?format=step&filename=box.step&target=cadquery",
            content=b"not cad",
            headers={"content-type": "application/octet-stream"},
        )
        self.assertEqual(response.status_code, 422)

    def test_render_rejects_external_import_before_running_openscad(self) -> None:
        response = TestClient(app).post(
            "/api/render",
            json={
                "files": [{"name": "main.scad", "source": 'import("/tmp/private.stl");'}],
                "mainFile": "main.scad",
                "parameters": {},
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("External CAD", response.json()["detail"])

    def test_serializes_supported_parameter_values(self) -> None:
        self.assertEqual(parameter_definition("enabled", True), "enabled=true")
        self.assertEqual(parameter_definition("label", 'A "quoted" label'), 'label="A \\"quoted\\" label"')
        self.assertEqual(parameter_definition("width", 12.5), "width=12.5")
        self.assertEqual(parameter_definition("size", [2, 1, 3.5]), "size=[2,1,3.5]")
        self.assertEqual(parameter_definition("nested", [[6.5, 2.4], [True, "safe"]]), 'nested=[[6.5,2.4],[true,"safe"]]')

    def test_rejects_unsafe_scad_paths(self) -> None:
        for path in ("../secret.scad", "/tmp/model.scad", "model.txt", 'bad\"name.scad'):
            with self.subTest(path=path), self.assertRaises(HTTPException):
                safe_scad_path(path)

        self.assertEqual(str(safe_scad_path("模型.scad")), "模型.scad")

    def test_allows_only_supplied_relative_scad_includes(self) -> None:
        files = {safe_scad_path("main.scad"), safe_scad_path("lib/shape.scad")}
        validate_scad_source("include <lib/shape.scad>; shape();", files)
        validate_scad_source("include <BOSL2/std.scad>; cuboid(10);", files)
        validate_scad_source(
            """
            // use <../matrix/m_transpose.scad>
            /* include </etc/passwd.scad>; */
            echo("import(\\"private.stl\\")");
            """,
            files,
        )
        with self.assertRaises(HTTPException):
            validate_scad_source("include </etc/passwd.scad>;", files)
        with self.assertRaises(HTTPException):
            validate_scad_source("include <missing.scad>;", files)
        with self.assertRaises(HTTPException):
            validate_scad_source("include <unbundled/std.scad>;", files)

    def test_accepts_bundled_gridfinity_rebuilt_sources(self) -> None:
        source_root = Path(__file__).resolve().parents[2] / "src" / "features" / "cadEditors" / "scad" / "gridfinity"
        shared = ("gridfinity-rebuilt-utility.scad", "gridfinity-constants.scad")
        for name in (
            "gridfinity-rebuilt-bins.scad",
            "gridfinity-rebuilt-lite.scad",
            "gridfinity-rebuilt-baseplate.scad",
        ):
            with self.subTest(name=name):
                available = {safe_scad_path(part) for part in (name, *shared)}
                for part in (name, *shared):
                    validate_scad_source(
                        (source_root / part).read_text(encoding="utf-8"),
                        available,
                    )

    def test_rejects_gridfinity_generator_without_its_shared_files(self) -> None:
        source_root = Path(__file__).resolve().parents[2] / "src" / "features" / "cadEditors" / "scad" / "gridfinity"
        source = (source_root / "gridfinity-rebuilt-bins.scad").read_text(encoding="utf-8")
        with self.assertRaises(HTTPException):
            validate_scad_source(source, {safe_scad_path("gridfinity-rebuilt-bins.scad")})

    def test_accepts_bundled_opengrid_source(self) -> None:
        source_path = (
            Path(__file__).resolve().parents[2]
            / "src"
            / "features"
            / "cadEditors"
            / "scad"
            / "opengrid"
            / "openGrid.scad"
        )
        validate_scad_source(
            source_path.read_text(encoding="utf-8"),
            {safe_scad_path(source_path.name)},
        )

    def test_rejects_external_asset_imports(self) -> None:
        with self.assertRaises(HTTPException):
            validate_scad_source('import("/tmp/private.stl");', {safe_scad_path("main.scad")})

    def test_rejects_parameter_expressions(self) -> None:
        with self.assertRaises(HTTPException):
            parameter_definition("width; import(\"secret\")", 10)
        with self.assertRaises(HTTPException):
            parameter_definition("width", {"expression": "10 + 2"})
        with self.assertRaises(HTTPException):
            parameter_definition("width", list(range(65)))


if __name__ == "__main__":
    unittest.main()
