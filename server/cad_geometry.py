from __future__ import annotations

import argparse
import base64
from collections import Counter
from dataclasses import dataclass
from io import BytesIO
import json
import math
from pathlib import Path
import re
from typing import Any

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_SurfaceOfExtrusion
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Shape

MAX_TRIANGLES = 500_000
MAX_VERTICES = 500_000
MAX_GENERATED_SCAD_BYTES = 32 * 1024 * 1024
MAX_GENERATED_BUILD123D_BYTES = 32 * 1024 * 1024
BODY_COLORS = (
    (0.37, 0.78, 0.68),
    (0.44, 0.66, 0.88),
    (0.91, 0.68, 0.35),
    (0.75, 0.54, 0.82),
    (0.87, 0.49, 0.49),
)


class CadConversionError(ValueError):
    pass


@dataclass(frozen=True)
class Bounds:
    minimum: tuple[float, float, float]
    size: tuple[float, float, float]


@dataclass(frozen=True)
class CylinderFeature:
    origin: tuple[float, float, float]
    direction: tuple[float, float, float]
    height: float
    outer_radius: float
    inner_radius: float | None = None


@dataclass(frozen=True)
class ExtrusionFeature:
    origin: tuple[float, float, float]
    x_direction: tuple[float, float, float]
    y_direction: tuple[float, float, float]
    direction: tuple[float, float, float]
    width: float
    depth: float
    height: float
    profile_triangles: list[tuple[tuple[float, float], tuple[float, float], tuple[float, float]]]


@dataclass
class BodyAnalysis:
    bounds: Bounds
    brep: str
    feature: CylinderFeature | ExtrusionFeature | str | None
    surface_types: Counter[str]
    mesh: tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]


def _clean_comment(value: str) -> str:
    return " ".join(value.replace("/*", "/ *").replace("*/", "* /").split())


def _format_number(value: float) -> str:
    if not math.isfinite(value):
        raise CadConversionError("The CAD model contains a non-finite coordinate.")
    rounded = round(value, 6)
    if rounded == 0:
        return "0"
    return format(rounded, ".6f").rstrip("0").rstrip(".")


def _vector(values: tuple[float, float, float]) -> str:
    return f"[{', '.join(_format_number(value) for value in values)}]"


def _read_shape(path: Path, cad_format: str) -> TopoDS_Shape:
    if cad_format == "step":
        reader = STEPControl_Reader()
        if reader.ReadFile(str(path)) != IFSelect_RetDone or reader.TransferRoots() < 1:
            raise CadConversionError("OpenCascade could not read this STEP file.")
        shape = reader.OneShape()
    elif cad_format == "iges":
        reader = IGESControl_Reader()
        if reader.ReadFile(str(path)) != IFSelect_RetDone or reader.TransferRoots() < 1:
            raise CadConversionError("OpenCascade could not read this IGES file.")
        shape = reader.OneShape()
    elif cad_format == "brep":
        shape = TopoDS_Shape()
        if not BRepTools.Read_s(shape, str(path), BRep_Builder()):
            raise CadConversionError("OpenCascade could not read this BREP file.")
    else:
        raise CadConversionError("Unsupported CAD format.")

    if shape.IsNull():
        raise CadConversionError("The CAD file did not contain usable boundary geometry.")
    return shape


def _solid_bodies(shape: TopoDS_Shape) -> list[TopoDS_Shape]:
    bodies: list[TopoDS_Shape] = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        bodies.append(TopoDS.Solid(explorer.Current()))
        explorer.Next()
    return bodies or [shape]


def _body_bounds(body: TopoDS_Shape) -> Bounds:
    box = Bnd_Box()
    box.SetGap(0.0)
    BRepBndLib.Add_s(body, box)
    minimum = box.CornerMin()
    maximum = box.CornerMax()
    return Bounds(
        (minimum.X(), minimum.Y(), minimum.Z()),
        (maximum.X() - minimum.X(), maximum.Y() - minimum.Y(), maximum.Z() - minimum.Z()),
    )


def _body_volume(body: TopoDS_Shape) -> float:
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(body, properties)
    return abs(properties.Mass())


def _body_vertices(body: TopoDS_Shape) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    explorer = TopExp_Explorer(body, TopAbs_VERTEX)
    while explorer.More():
        point = BRep_Tool.Pnt_s(TopoDS.Vertex(explorer.Current()))
        points.append((point.X(), point.Y(), point.Z()))
        explorer.Next()
    return points


def _body_surfaces(body: TopoDS_Shape) -> tuple[list[tuple[Any, BRepAdaptor_Surface]], Counter[str]]:
    surfaces: list[tuple[Any, BRepAdaptor_Surface]] = []
    types: Counter[str] = Counter()
    explorer = TopExp_Explorer(body, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        surface = BRepAdaptor_Surface(face)
        surfaces.append((face, surface))
        types[str(surface.GetType()).rsplit(".", 1)[-1].removeprefix("GeomAbs_")] += 1
        explorer.Next()
    return surfaces, types


def _relative_match(actual: float, expected: float, tolerance: float = 0.005) -> bool:
    return expected > 0 and abs(actual - expected) <= max(expected * tolerance, 1e-6)


def _canonical_direction(direction: tuple[float, float, float]) -> tuple[float, float, float]:
    for value in direction:
        if abs(value) > 1e-9:
            return direction if value > 0 else tuple(-item for item in direction)
    return direction


def _parallel(first: tuple[float, float, float], second: tuple[float, float, float]) -> bool:
    return abs(sum(left * right for left, right in zip(first, second, strict=True))) > 0.999999


def _axis_distance(
    first_origin: tuple[float, float, float],
    second_origin: tuple[float, float, float],
    direction: tuple[float, float, float],
) -> float:
    difference = tuple(right - left for left, right in zip(first_origin, second_origin, strict=True))
    projection = sum(value * axis for value, axis in zip(difference, direction, strict=True))
    perpendicular = tuple(value - projection * axis for value, axis in zip(difference, direction, strict=True))
    return math.sqrt(sum(value * value for value in perpendicular))


def _dot(first: tuple[float, float, float], second: tuple[float, float, float]) -> float:
    return sum(left * right for left, right in zip(first, second, strict=True))


def _cross(
    first: tuple[float, float, float], second: tuple[float, float, float]
) -> tuple[float, float, float]:
    return (
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    )


def _normalize(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    length = math.sqrt(_dot(vector, vector))
    return tuple(value / length for value in vector)


def _profile_basis(
    direction: tuple[float, float, float]
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    helper = (0.0, 0.0, 1.0) if abs(direction[2]) < 0.9 else (1.0, 0.0, 0.0)
    x_direction = _normalize(_cross(helper, direction))
    return x_direction, _normalize(_cross(direction, x_direction))


def _face_points(face: Any) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    explorer = TopExp_Explorer(face, TopAbs_VERTEX)
    while explorer.More():
        point = BRep_Tool.Pnt_s(TopoDS.Vertex(explorer.Current()))
        points.append((point.X(), point.Y(), point.Z()))
        explorer.Next()
    return points


def _face_triangles(face: Any) -> list[tuple[tuple[float, float, float], ...]]:
    location = TopLoc_Location()
    triangulation = BRep_Tool.Triangulation_s(face, location)
    if triangulation is None:
        return []
    transformation = location.Transformation()
    triangles: list[tuple[tuple[float, float, float], ...]] = []
    for triangle_index in range(1, triangulation.NbTriangles() + 1):
        indexes = triangulation.Triangle(triangle_index).Get()
        points = []
        for node_index in indexes:
            point = triangulation.Node(node_index).Transformed(transformation)
            points.append((point.X(), point.Y(), point.Z()))
        triangles.append(tuple(points))
    return triangles


def _surface_axis(surface: BRepAdaptor_Surface) -> tuple[float, float, float] | None:
    if surface.GetType() == GeomAbs_Cylinder:
        direction = surface.Cylinder().Axis().Direction()
    elif surface.GetType() == GeomAbs_SurfaceOfExtrusion:
        direction = surface.Direction()
    else:
        return None
    return _canonical_direction((direction.X(), direction.Y(), direction.Z()))


def _try_extrusion(
    body: TopoDS_Shape,
    faces_and_surfaces: list[tuple[Any, BRepAdaptor_Surface]],
    direction: tuple[float, float, float],
) -> ExtrusionFeature | None:
    cap_faces: list[Any] = []
    cap_normal: tuple[float, float, float] | None = None
    for face, surface in faces_and_surfaces:
        if surface.GetType() == GeomAbs_Plane:
            normal = surface.Plane().Axis().Direction()
            normal_vector = _canonical_direction((normal.X(), normal.Y(), normal.Z()))
            alignment = abs(_dot(normal_vector, direction))
            if alignment > 1e-4:
                if cap_normal is not None and not _parallel(cap_normal, normal_vector):
                    return None
                cap_normal = normal_vector
                cap_faces.append(face)
            elif alignment > 1e-7:
                return None
        elif surface.GetType() in (GeomAbs_Cylinder, GeomAbs_SurfaceOfExtrusion):
            axis = _surface_axis(surface)
            if axis is None or not _parallel(axis, direction):
                return None
        else:
            return None
    if len(cap_faces) < 2 or cap_normal is None:
        return None
    if _dot(cap_normal, direction) < 0:
        direction = tuple(-value for value in direction)

    points = _body_vertices(body)
    normal_projections = [_dot(point, cap_normal) for point in points]
    minimum_normal, maximum_normal = min(normal_projections), max(normal_projections)
    normal_height = maximum_normal - minimum_normal
    direction_alignment = abs(_dot(cap_normal, direction))
    height = normal_height / direction_alignment
    if height <= 1e-6 or direction_alignment <= 1e-4:
        return None

    tolerance = max(normal_height * 1e-6, 1e-5)
    lower_caps = [
        face
        for face in cap_faces
        if _face_points(face)
        and max(abs(_dot(point, cap_normal) - minimum_normal) for point in _face_points(face)) <= tolerance
    ]
    if not lower_caps:
        return None

    x_direction, y_direction = _profile_basis(cap_normal)
    minimum_x = min(_dot(point, x_direction) for point in points)
    maximum_x = max(_dot(point, x_direction) for point in points)
    minimum_y = min(_dot(point, y_direction) for point in points)
    maximum_y = max(_dot(point, y_direction) for point in points)
    profile_triangles: list[tuple[tuple[float, float], tuple[float, float], tuple[float, float]]] = []
    profile_area = 0.0
    for face in lower_caps:
        for triangle in _face_triangles(face):
            projected = tuple(
                (_dot(point, x_direction) - minimum_x, _dot(point, y_direction) - minimum_y)
                for point in triangle
            )
            twice_area = abs(
                (projected[1][0] - projected[0][0]) * (projected[2][1] - projected[0][1])
                - (projected[2][0] - projected[0][0]) * (projected[1][1] - projected[0][1])
            )
            if twice_area > 1e-10:
                profile_area += twice_area / 2
                profile_triangles.append(projected)
    if not profile_triangles or not _relative_match(_body_volume(body), profile_area * normal_height, 0.01):
        return None

    origin = tuple(
        minimum_x * x_axis + minimum_y * y_axis + minimum_normal * normal_axis
        for x_axis, y_axis, normal_axis in zip(x_direction, y_direction, cap_normal, strict=True)
    )
    return ExtrusionFeature(
        origin,
        x_direction,
        y_direction,
        direction,
        maximum_x - minimum_x,
        maximum_y - minimum_y,
        height,
        profile_triangles,
    )


def _recognize_feature(
    body: TopoDS_Shape,
    bounds: Bounds,
    faces_and_surfaces: list[tuple[Any, BRepAdaptor_Surface]],
) -> CylinderFeature | ExtrusionFeature | str | None:
    surfaces = [surface for _face, surface in faces_and_surfaces]
    volume = _body_volume(body)
    if surfaces and all(surface.GetType() == GeomAbs_Plane for surface in surfaces):
        box_volume = math.prod(bounds.size)
        if len(surfaces) == 6 and _relative_match(volume, box_volume):
            return "box"

    if not surfaces:
        return None

    cylinders: list[tuple[float, tuple[float, float, float], tuple[float, float, float]]] = []
    for surface in surfaces:
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        cylinder = surface.Cylinder()
        axis = cylinder.Axis()
        direction = _canonical_direction((axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()))
        origin = (axis.Location().X(), axis.Location().Y(), axis.Location().Z())
        candidate = (cylinder.Radius(), origin, direction)
        if not any(
            abs(existing[0] - candidate[0]) < 1e-6
            and _parallel(existing[2], candidate[2])
            and _axis_distance(existing[1], candidate[1], candidate[2]) < 1e-5
            for existing in cylinders
        ):
            cylinders.append(candidate)

    only_cylinder_and_plane = all(
        surface.GetType() in (GeomAbs_Plane, GeomAbs_Cylinder) for surface in surfaces
    )
    if only_cylinder_and_plane and len(cylinders) in (1, 2):
        _first_radius, axis_origin, direction = cylinders[0]
        axes_match = all(_parallel(direction, candidate[2]) for candidate in cylinders[1:]) and all(
            _axis_distance(axis_origin, candidate[1], direction) <= 1e-5 for candidate in cylinders[1:]
        )
        if axes_match:
            projections = [
                sum(
                    (coordinate - origin) * axis
                    for coordinate, origin, axis in zip(point, axis_origin, direction, strict=True)
                )
                for point in _body_vertices(body)
            ]
            minimum_projection = min(projections)
            height = max(projections) - minimum_projection
            origin = tuple(value + minimum_projection * axis for value, axis in zip(axis_origin, direction, strict=True))
            radii = sorted(candidate[0] for candidate in cylinders)
            outer_radius = radii[-1]
            inner_radius = radii[0] if len(radii) == 2 else None
            expected_volume = math.pi * (outer_radius**2 - (inner_radius or 0) ** 2) * height
            if _relative_match(volume, expected_volume):
                return CylinderFeature(origin, direction, height, outer_radius, inner_radius)

    candidate_axes: list[tuple[float, float, float]] = []
    for _face, surface in faces_and_surfaces:
        axis = _surface_axis(surface)
        if axis is None and surface.GetType() == GeomAbs_Plane:
            normal = surface.Plane().Axis().Direction()
            axis = _canonical_direction((normal.X(), normal.Y(), normal.Z()))
        if axis is not None and not any(_parallel(axis, existing) for existing in candidate_axes):
            candidate_axes.append(axis)
    for axis in candidate_axes:
        extrusion = _try_extrusion(body, faces_and_surfaces, axis)
        if extrusion is not None:
            return extrusion
    return None


def _body_mesh(body: TopoDS_Shape) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    points: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    explorer = TopExp_Explorer(body, TopAbs_FACE)

    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is not None:
            point_offset = len(points)
            transformation = location.Transformation()
            for node_index in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(node_index).Transformed(transformation)
                points.append((point.X(), point.Y(), point.Z()))

            reverse = face.Orientation() == TopAbs_REVERSED
            for triangle_index in range(1, triangulation.NbTriangles() + 1):
                first, second, third = triangulation.Triangle(triangle_index).Get()
                if reverse:
                    second, third = third, second
                faces.append((point_offset + first - 1, point_offset + second - 1, point_offset + third - 1))
        explorer.Next()

    return points, faces


def _body_brep(body: TopoDS_Shape) -> str:
    output = BytesIO()
    BRepTools.Write_s(body, output)
    return base64.b64encode(output.getvalue()).decode("ascii")


def _parameter(lines: list[str], description: str, name: str, value: float) -> None:
    lines.extend((f"// {description}", f"{name} = {_format_number(value)};", ""))


def _rotation(direction: tuple[float, float, float]) -> tuple[float, tuple[float, float, float]]:
    clamped_z = max(-1.0, min(1.0, direction[2]))
    angle = math.degrees(math.acos(clamped_z))
    axis = (-direction[1], direction[0], 0.0)
    if abs(angle) < 1e-8:
        return 0.0, (1.0, 0.0, 0.0)
    if abs(angle - 180.0) < 1e-8:
        return 180.0, (1.0, 0.0, 0.0)
    return angle, axis


def _mesh_module(lines: list[str], body_index: int, analysis: BodyAnalysis) -> None:
    points, faces = analysis.mesh
    minimum = analysis.bounds.minimum
    lines.extend((f"module reference_mesh_{body_index:02d}() {{", "  polyhedron(", "    points = ["))
    for point_index, point in enumerate(points):
        local = tuple(value - origin for value, origin in zip(point, minimum, strict=True))
        suffix = "," if point_index + 1 < len(points) else ""
        lines.append(f"      {_vector(local)}{suffix}")
    lines.extend(("    ],", "    faces = ["))
    for face_index, face in enumerate(faces):
        suffix = "," if face_index + 1 < len(faces) else ""
        lines.append(f"      [{face[0]}, {face[1]}, {face[2]}]{suffix}")
    lines.extend(("    ],", "    convexity = 10", "  );", "}", ""))


def _body_source(lines: list[str], body_index: int, analysis: BodyAnalysis) -> dict[str, Any]:
    prefix = f"body_{body_index:02d}"
    if analysis.feature == "box":
        lines.append(f"/* [Body {body_index:02d} - recognized box] */")
        for axis, value in zip(("x", "y", "z"), analysis.bounds.minimum, strict=True):
            _parameter(lines, f"Body {body_index} {axis.upper()} position in millimetres.", f"{prefix}_{axis}", value)
        for label, value in zip(("width", "depth", "height"), analysis.bounds.size, strict=True):
            _parameter(lines, f"Recognized body {label} in millimetres.", f"{prefix}_{label}", value)
        lines.extend(
            (
                f"module {prefix}() {{",
                f"  translate([{prefix}_x, {prefix}_y, {prefix}_z])",
                f"    cube([{prefix}_width, {prefix}_depth, {prefix}_height]);",
                "}",
                "",
            )
        )
        return {"body": body_index, "confidence": "high", "type": "box"}

    if isinstance(analysis.feature, CylinderFeature):
        feature = analysis.feature
        kind = "tube" if feature.inner_radius is not None else "cylinder"
        lines.append(f"/* [Body {body_index:02d} - recognized {kind}] */")
        for axis, value in zip(("x", "y", "z"), feature.origin, strict=True):
            _parameter(lines, f"Body {body_index} axis origin {axis.upper()} in millimetres.", f"{prefix}_{axis}", value)
        _parameter(lines, "Outer radius in millimetres.", f"{prefix}_radius", feature.outer_radius)
        if feature.inner_radius is not None:
            _parameter(lines, "Bore radius in millimetres.", f"{prefix}_bore_radius", feature.inner_radius)
        _parameter(lines, "Length along the recognized axis in millimetres.", f"{prefix}_height", feature.height)
        angle, rotation_axis = _rotation(feature.direction)
        lines.extend((f"module {prefix}() {{", f"  translate([{prefix}_x, {prefix}_y, {prefix}_z])"))
        if abs(angle) > 1e-8:
            lines.append(f"    rotate(a={_format_number(angle)}, v={_vector(rotation_axis)})")
        if feature.inner_radius is None:
            lines.append(f"      cylinder(h={prefix}_height, r={prefix}_radius);")
        else:
            lines.extend(
                (
                    "      difference() {",
                    f"        cylinder(h={prefix}_height, r={prefix}_radius);",
                    f"        translate([0, 0, -0.01]) cylinder(h={prefix}_height + 0.02, r={prefix}_bore_radius);",
                    "      }",
                )
            )
        lines.extend(("}", ""))
        return {"body": body_index, "confidence": "high", "type": kind}

    if isinstance(analysis.feature, ExtrusionFeature):
        feature = analysis.feature
        lines.append(f"/* [Body {body_index:02d} - recognized extrusion] */")
        for axis, value in zip(("x", "y", "z"), feature.origin, strict=True):
            _parameter(lines, f"Body {body_index} profile origin {axis.upper()} in millimetres.", f"{prefix}_{axis}", value)
        _parameter(lines, "Editable profile width in millimetres.", f"{prefix}_width", feature.width)
        _parameter(lines, "Editable profile depth in millimetres.", f"{prefix}_depth", feature.depth)
        _parameter(lines, "Editable extrusion length in millimetres.", f"{prefix}_height", feature.height)
        lines.extend((f"module {prefix}_profile() {{", "  union() {"))
        for triangle in feature.profile_triangles:
            points = ", ".join(
                f"[{_format_number(point[0])}, {_format_number(point[1])}]" for point in triangle
            )
            lines.append(f"    polygon(points=[{points}]);")
        lines.extend(("  }", "}", "", f"module {prefix}() {{"))
        matrix = (
            (feature.x_direction[0], feature.y_direction[0], feature.direction[0], 0.0),
            (feature.x_direction[1], feature.y_direction[1], feature.direction[1], 0.0),
            (feature.x_direction[2], feature.y_direction[2], feature.direction[2], 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )
        matrix_source = ", ".join(
            f"[{', '.join(_format_number(value) for value in row)}]" for row in matrix
        )
        lines.extend(
            (
                f"  translate([{prefix}_x, {prefix}_y, {prefix}_z])",
                f"    multmatrix(m=[{matrix_source}])",
                f"      linear_extrude(height={prefix}_height)",
                f"        scale([{prefix}_width / {_format_number(feature.width)}, {prefix}_depth / {_format_number(feature.depth)}])",
                f"          {prefix}_profile();",
                "}",
                "",
            )
        )
        return {"body": body_index, "confidence": "high", "type": "linear_extrusion"}

    lines.append(f"/* [Body {body_index:02d} - adjustable reference] */")
    for axis, value in zip(("x", "y", "z"), analysis.bounds.minimum, strict=True):
        _parameter(lines, f"Body {body_index} {axis.upper()} position in millimetres.", f"{prefix}_{axis}", value)
    for label, value in zip(("width", "depth", "height"), analysis.bounds.size, strict=True):
        _parameter(lines, f"Reference body {label}; adjust while replacing this mesh.", f"{prefix}_{label}", value)
    surface_summary = ", ".join(f"{name}: {count}" for name, count in analysis.surface_types.most_common())
    lines.extend(
        (
            f"// Unresolved BREP surfaces: {surface_summary}.",
            f"module {prefix}() {{",
            f"  translate([{prefix}_x, {prefix}_y, {prefix}_z])",
            f"    resize([{prefix}_width, {prefix}_depth, {prefix}_height])",
            f"      reference_mesh_{body_index:02d}();",
            "}",
            "",
        )
    )
    return {"body": body_index, "confidence": "reference", "type": "unresolved"}


def _scad_source(analyses: list[BodyAnalysis], source_name: str) -> tuple[str, list[dict[str, Any]], int, int]:
    vertex_count = sum(len(analysis.mesh[0]) for analysis in analyses)
    triangle_count = sum(len(analysis.mesh[1]) for analysis in analyses)
    if vertex_count > MAX_VERTICES or triangle_count > MAX_TRIANGLES:
        raise CadConversionError(
            f"The CAD model is too complex ({vertex_count:,} vertices, {triangle_count:,} triangles)."
        )

    recognized_count = sum(analysis.feature is not None for analysis in analyses)
    lines = [
        "// Best-effort parametric reconstruction generated transiently by Klippee.",
        f"// Source: {_clean_comment(source_name)}",
        f"// Recognized {recognized_count} of {len(analyses)} bodies as editable native primitives.",
        "// Unresolved bodies are adjustable reference meshes, not inferred feature history.",
        "// Replace reference modules as you recover the intended construction.",
        "",
        "/* [Reconstruction] */",
        "// Include confidently recognized native OpenSCAD primitives.",
        "show_recognized_parts = true;",
        "",
        "// Include unresolved geometry as dimensionally adjustable references.",
        "show_reference_parts = true;",
        "",
    ]

    for body_index, analysis in enumerate(analyses, start=1):
        if analysis.feature is None:
            _mesh_module(lines, body_index, analysis)

    features = [
        _body_source(lines, body_index, analysis)
        for body_index, analysis in enumerate(analyses, start=1)
    ]

    lines.extend(("/* [Hidden] */", "union() {"))
    for body_index, analysis in enumerate(analyses, start=1):
        color = BODY_COLORS[(body_index - 1) % len(BODY_COLORS)]
        condition = "show_recognized_parts" if analysis.feature is not None else "show_reference_parts"
        lines.append(
            f"  if ({condition}) color({_vector(color)}) body_{body_index:02d}();"
        )
    lines.extend(("}", ""))
    source = "\n".join(lines)
    if len(source.encode("utf-8")) > MAX_GENERATED_SCAD_BYTES:
        raise CadConversionError("The reconstructed OpenSCAD model exceeds the 32 MB output limit.")
    return source, features, vertex_count, triangle_count


def _reconstruction_parameters(plan: dict[str, Any]) -> list[dict[str, Any]]:
    parameters = [
        {
            "defaultValue": True,
            "description": "Include confidently reconstructed native bodies.",
            "group": "Reconstruction",
            "key": "show_recognized_parts",
            "label": "Show recognized parts",
            "type": "boolean",
        },
        {
            "defaultValue": True,
            "description": "Include unresolved exact BREP reference bodies.",
            "group": "Reconstruction",
            "key": "show_reference_parts",
            "label": "Show reference parts",
            "type": "boolean",
        },
    ]
    for body in plan["bodies"]:
        body_index = body["index"]
        confidence = "recognized" if body["kind"] != "reference" else "reference"
        group = f"Body {body_index:02d} - {confidence} {body['kind']}"
        labels = {
            "x": "X position",
            "y": "Y position",
            "z": "Z position",
            "width": "Width",
            "depth": "Depth",
            "height": "Height",
            "radius": "Outer radius",
            "bore_radius": "Bore radius",
        }
        for name, value in body["parameters"].items():
            parameters.append(
                {
                    "defaultValue": value,
                    "description": f"Body {body_index} {labels[name].lower()} in millimetres.",
                    "group": group,
                    "key": f"body_{body_index:02d}_{name}",
                    "label": labels[name],
                    "step": 0.1,
                    "type": "number",
                }
            )
    return parameters


def _reconstruction_plan(analyses: list[BodyAnalysis], source_name: str) -> dict[str, Any]:
    bodies: list[dict[str, Any]] = []
    for body_index, analysis in enumerate(analyses, start=1):
        prefix_parameters = {
            "x": analysis.bounds.minimum[0],
            "y": analysis.bounds.minimum[1],
            "z": analysis.bounds.minimum[2],
        }
        if analysis.feature == "box":
            bodies.append(
                {
                    "index": body_index,
                    "kind": "box",
                    "parameters": {
                        **prefix_parameters,
                        "width": analysis.bounds.size[0],
                        "depth": analysis.bounds.size[1],
                        "height": analysis.bounds.size[2],
                    },
                }
            )
        elif isinstance(analysis.feature, CylinderFeature):
            feature = analysis.feature
            parameters = {
                "x": feature.origin[0],
                "y": feature.origin[1],
                "z": feature.origin[2],
                "radius": feature.outer_radius,
                "height": feature.height,
            }
            if feature.inner_radius is not None:
                parameters["bore_radius"] = feature.inner_radius
            bodies.append(
                {
                    "direction": feature.direction,
                    "index": body_index,
                    "kind": "tube" if feature.inner_radius is not None else "cylinder",
                    "parameters": parameters,
                }
            )
        elif isinstance(analysis.feature, ExtrusionFeature):
            feature = analysis.feature
            bodies.append(
                {
                    "direction": feature.direction,
                    "index": body_index,
                    "kind": "linear_extrusion",
                    "parameters": {
                        "x": feature.origin[0],
                        "y": feature.origin[1],
                        "z": feature.origin[2],
                        "width": feature.width,
                        "depth": feature.depth,
                        "height": feature.height,
                    },
                    "profileDepth": feature.depth,
                    "profileTriangles": feature.profile_triangles,
                    "profileWidth": feature.width,
                    "xDirection": feature.x_direction,
                    "yDirection": feature.y_direction,
                }
            )
        else:
            bodies.append(
                {
                    "bounds": {"minimum": analysis.bounds.minimum, "size": analysis.bounds.size},
                    "brep": analysis.brep,
                    "index": body_index,
                    "kind": "reference",
                    "parameters": {
                        **prefix_parameters,
                        "width": analysis.bounds.size[0],
                        "depth": analysis.bounds.size[1],
                        "height": analysis.bounds.size[2],
                    },
                }
            )
    return {
        "bodies": bodies,
        "showRecognizedParts": True,
        "showReferenceParts": True,
        "sourceName": _clean_comment(source_name),
        "version": 1,
    }


def _python_value(value: object) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return _format_number(float(value))
    raise CadConversionError("CAD reconstruction contains an unsupported parameter value.")


def _build123d_source(plan: dict[str, Any]) -> str:
    recognized_count = sum(body["kind"] != "reference" for body in plan["bodies"])
    lines = [
        '"""Best-effort build123d reconstruction generated transiently by Klippee."""',
        "",
        "import base64",
        "from pathlib import Path",
        "from tempfile import TemporaryDirectory",
        "import build123d as b3d",
        "",
        f"# Source: {plan['sourceName']}",
        f"# Recognized {recognized_count} of {len(plan['bodies'])} bodies as native operations.",
        "# Unresolved bodies remain exact embedded BREP references.",
        "",
        f"show_recognized_parts = {_python_value(plan.get('showRecognizedParts', True))}",
        f"show_reference_parts = {_python_value(plan.get('showReferenceParts', True))}",
        "",
        "def import_brep_data(encoded):",
        '    with TemporaryDirectory(prefix="klippee-build123d-") as temporary:',
        '        path = Path(temporary) / "reference.brep"',
        '        path.write_bytes(base64.b64decode(encoded, validate=True))',
        "        return b3d.import_brep(path)",
        "",
        "parts = []",
        "",
    ]
    for body in plan["bodies"]:
        index = body["index"]
        prefix = f"body_{index:02d}"
        lines.append(f"# Body {index:02d}: {body['kind']}")
        for name, value in body["parameters"].items():
            lines.append(f"{prefix}_{name} = {_python_value(value)}")
        if body["kind"] == "box":
            lines.extend(
                (
                    f"{prefix} = b3d.Solid.make_box({prefix}_width, {prefix}_depth, {prefix}_height, b3d.Plane(origin=({prefix}_x, {prefix}_y, {prefix}_z)))",
                    f"if show_recognized_parts: parts.append({prefix})",
                )
            )
        elif body["kind"] in ("cylinder", "tube"):
            direction = tuple(body["direction"])
            direction_source = ", ".join(_format_number(value) for value in direction)
            lines.extend(
                (
                    f"{prefix}_plane = b3d.Plane(origin=({prefix}_x, {prefix}_y, {prefix}_z), z_dir=({direction_source}))",
                    f"{prefix} = b3d.Solid.make_cylinder({prefix}_radius, {prefix}_height, {prefix}_plane)",
                )
            )
            if body["kind"] == "tube":
                lines.append(
                    f"{prefix} = {prefix}.cut(b3d.Solid.make_cylinder({prefix}_bore_radius, {prefix}_height, {prefix}_plane))"
                )
            lines.append(f"if show_recognized_parts: parts.append({prefix})")
        elif body["kind"] == "linear_extrusion":
            lines.extend(
                (
                    f"{prefix}_solids = []",
                    f"{prefix}_sx = {prefix}_width / {_format_number(body['profileWidth'])}",
                    f"{prefix}_sy = {prefix}_depth / {_format_number(body['profileDepth'])}",
                )
            )
            x_direction = body["xDirection"]
            y_direction = body["yDirection"]
            direction = body["direction"]
            for triangle in body["profileTriangles"]:
                point_sources = []
                for point in triangle:
                    coordinates = [
                        f"{prefix}_{axis} + ({_format_number(point[0])} * {prefix}_sx * {_format_number(x_direction[coordinate])}) + ({_format_number(point[1])} * {prefix}_sy * {_format_number(y_direction[coordinate])})"
                        for coordinate, axis in enumerate(("x", "y", "z"))
                    ]
                    point_sources.append(f"({', '.join(coordinates)})")
                vector = ", ".join(
                    f"{prefix}_height * {_format_number(direction[coordinate])}" for coordinate in range(3)
                )
                lines.append(
                    f"{prefix}_solids.append(b3d.Solid.extrude(b3d.Face(b3d.Wire.make_polygon([{', '.join(point_sources)}], close=True)), ({vector})))"
                )
            lines.extend(
                (
                    f"{prefix} = b3d.Compound({prefix}_solids)",
                    f"if show_recognized_parts: parts.append({prefix})",
                )
            )
        else:
            encoded = body["brep"]
            bounds = body["bounds"]
            minimum = bounds["minimum"]
            size = bounds["size"]
            lines.extend(
                (
                    f"{prefix} = import_brep_data({encoded!r})",
                    f"{prefix}_matrix = b3d.Matrix([[{prefix}_width / {_format_number(size[0])}, 0, 0, {prefix}_x - ({_format_number(minimum[0])} * {prefix}_width / {_format_number(size[0])})], [0, {prefix}_depth / {_format_number(size[1])}, 0, {prefix}_y - ({_format_number(minimum[1])} * {prefix}_depth / {_format_number(size[1])})], [0, 0, {prefix}_height / {_format_number(size[2])}, {prefix}_z - ({_format_number(minimum[2])} * {prefix}_height / {_format_number(size[2])})]])",
                    f"{prefix} = {prefix}.transform_geometry({prefix}_matrix)",
                    f"if show_reference_parts: parts.append({prefix})",
                )
            )
        lines.append("")
    lines.extend(("result = b3d.Compound(parts)", ""))
    source = "\n".join(lines)
    if len(source.encode("utf-8")) > MAX_GENERATED_BUILD123D_BYTES:
        raise CadConversionError("The reconstructed build123d model exceeds the 32 MB output limit.")
    return source


def validate_reconstruction_plan(plan: object) -> dict[str, Any]:
    if not isinstance(plan, dict) or plan.get("version") != 1 or not isinstance(plan.get("bodies"), list):
        raise CadConversionError("Invalid CAD reconstruction plan.")
    if not 1 <= len(plan["bodies"]) <= 500:
        raise CadConversionError("CAD reconstruction must contain between 1 and 500 bodies.")
    if (
        not isinstance(plan.get("sourceName"), str)
        or len(plan["sourceName"]) > 240
        or plan["sourceName"] != _clean_comment(plan["sourceName"])
    ):
        raise CadConversionError("Invalid CAD source name.")
    for flag in ("showRecognizedParts", "showReferenceParts"):
        if flag in plan and not isinstance(plan[flag], bool):
            raise CadConversionError("Invalid CAD visibility option.")

    expected_parameters = {
        "box": {"x", "y", "z", "width", "depth", "height"},
        "cylinder": {"x", "y", "z", "radius", "height"},
        "tube": {"x", "y", "z", "radius", "bore_radius", "height"},
        "linear_extrusion": {"x", "y", "z", "width", "depth", "height"},
        "reference": {"x", "y", "z", "width", "depth", "height"},
    }

    def finite_number(value: object) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def valid_vector(value: object) -> bool:
        return isinstance(value, (list, tuple)) and len(value) == 3 and all(finite_number(item) for item in value)

    seen_indexes: set[int] = set()
    triangle_count = 0
    for body in plan["bodies"]:
        if not isinstance(body, dict) or body.get("kind") not in expected_parameters:
            raise CadConversionError("CAD reconstruction contains an unsupported body.")
        index = body.get("index")
        if not isinstance(index, int) or index < 1 or index in seen_indexes:
            raise CadConversionError("CAD reconstruction contains an invalid body index.")
        seen_indexes.add(index)
        parameters = body.get("parameters")
        if not isinstance(parameters, dict) or set(parameters) != expected_parameters[body["kind"]]:
            raise CadConversionError(f"Body {index} has invalid CAD parameters.")
        if not all(finite_number(value) for value in parameters.values()):
            raise CadConversionError(f"Body {index} has a non-finite CAD parameter.")
        for name in expected_parameters[body["kind"]] - {"x", "y", "z"}:
            if parameters[name] <= 0:
                raise CadConversionError(f"Body {index} dimensions must be positive.")
        if body["kind"] == "tube" and parameters["bore_radius"] >= parameters["radius"]:
            raise CadConversionError(f"Body {index} bore radius must be smaller than its outer radius.")
        if body["kind"] in ("cylinder", "tube") and not valid_vector(body.get("direction")):
            raise CadConversionError(f"Body {index} has an invalid cylinder direction.")
        if body["kind"] == "linear_extrusion":
            if not all(valid_vector(body.get(name)) for name in ("direction", "xDirection", "yDirection")):
                raise CadConversionError(f"Body {index} has invalid extrusion directions.")
            if not finite_number(body.get("profileWidth")) or not finite_number(body.get("profileDepth")):
                raise CadConversionError(f"Body {index} has invalid profile dimensions.")
            triangles = body.get("profileTriangles")
            if not isinstance(triangles, list) or not triangles:
                raise CadConversionError(f"Body {index} has no extrusion profile.")
            triangle_count += len(triangles)
            if triangle_count > MAX_TRIANGLES:
                raise CadConversionError("CAD reconstruction contains too many profile triangles.")
            for triangle in triangles:
                if (
                    not isinstance(triangle, (list, tuple))
                    or len(triangle) != 3
                    or any(
                        not isinstance(point, (list, tuple))
                        or len(point) != 2
                        or not all(finite_number(value) for value in point)
                        for point in triangle
                    )
                ):
                    raise CadConversionError(f"Body {index} has an invalid extrusion profile.")
        if body["kind"] == "reference":
            bounds = body.get("bounds")
            if (
                not isinstance(bounds, dict)
                or not valid_vector(bounds.get("minimum"))
                or not valid_vector(bounds.get("size"))
                or any(value <= 0 for value in bounds["size"])
            ):
                raise CadConversionError(f"Body {index} has invalid reference bounds.")
            encoded = body.get("brep")
            if not isinstance(encoded, str) or len(encoded) > MAX_GENERATED_BUILD123D_BYTES * 2:
                raise CadConversionError(f"Body {index} has invalid BREP reference data.")
            try:
                base64.b64decode(encoded, validate=True)
            except ValueError as error:
                raise CadConversionError(f"Body {index} has invalid BREP reference data.") from error
    return plan


def apply_reconstruction_parameters(plan: dict[str, Any], values: object) -> dict[str, Any]:
    validate_reconstruction_plan(plan)
    if not isinstance(values, dict):
        raise CadConversionError("CAD parameters must be an object.")
    updated = json.loads(json.dumps(plan))
    bodies = {body["index"]: body for body in updated["bodies"]}
    for key, value in values.items():
        if key == "show_recognized_parts":
            if not isinstance(value, bool):
                raise CadConversionError("Invalid CAD visibility parameter.")
            updated["showRecognizedParts"] = value
            continue
        if key == "show_reference_parts":
            if not isinstance(value, bool):
                raise CadConversionError("Invalid CAD visibility parameter.")
            updated["showReferenceParts"] = value
            continue
        match = re.fullmatch(r"body_(\d{2,3})_([a-z_]+)", key) if isinstance(key, str) else None
        if match is None:
            raise CadConversionError("Unknown CAD parameter.")
        body = bodies.get(int(match.group(1)))
        name = match.group(2)
        if body is None or name not in body["parameters"]:
            raise CadConversionError("Unknown CAD parameter.")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise CadConversionError(f"CAD parameter {key} must be finite.")
        body["parameters"][name] = value
    validate_reconstruction_plan(updated)
    return updated


def convert_cad_file(path: Path, cad_format: str, source_name: str, target: str = "scad") -> dict[str, Any]:
    if target not in ("build123d", "scad"):
        raise CadConversionError("Unsupported reconstruction target.")
    shape = _read_shape(path, cad_format)
    mesher = BRepMesh_IncrementalMesh(shape, 0.1, False, 0.5, True)
    mesher.Perform()
    if not mesher.IsDone():
        raise CadConversionError("OpenCascade could not analyze this CAD model.")

    analyses: list[BodyAnalysis] = []
    for body in _solid_bodies(shape):
        bounds = _body_bounds(body)
        surfaces, surface_types = _body_surfaces(body)
        mesh = _body_mesh(body)
        if not mesh[1]:
            continue
        analyses.append(
            BodyAnalysis(
                bounds,
                _body_brep(body) if target == "build123d" else "",
                _recognize_feature(body, bounds, surfaces),
                surface_types,
                mesh,
            )
        )
    if not analyses:
        raise CadConversionError("The CAD file does not contain analyzable solid bodies.")

    source, features, vertex_count, triangle_count = _scad_source(analyses, source_name)
    recognized_count = sum(feature["confidence"] == "high" for feature in features)
    result = {
        "bodyCount": len(analyses),
        "engine": target,
        "features": features,
        "recognizedBodyCount": recognized_count,
        "referenceBodyCount": len(analyses) - recognized_count,
        "source": source,
        "triangleCount": triangle_count,
        "vertexCount": vertex_count,
    }
    if target == "build123d":
        plan = _reconstruction_plan(analyses, source_name)
        result.update(
            {
                "parameters": _reconstruction_parameters(plan),
                "plan": plan,
                "source": _build123d_source(plan),
            }
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=("brep", "iges", "step"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--target", choices=("build123d", "scad"), default="scad")
    args = parser.parse_args()
    try:
        result = convert_cad_file(args.input, args.format, args.source_name, args.target)
    except CadConversionError as error:
        parser.exit(2, f"{error}\n")
    args.output.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")


if __name__ == "__main__":
    main()
