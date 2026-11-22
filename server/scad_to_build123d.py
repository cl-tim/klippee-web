"""Convert OpenSCAD source into build123d Python source.

OpenSCAD is a full programming language, so this does not attempt to translate
it directly. Instead OpenSCAD itself flattens the script with its `csg` export,
which resolves every module, function, loop, variable, and `$fn` into a small
canonical tree of primitives and transforms. That tree is what gets translated
here, which reduces the problem from "transpile a language" to "walk about
twenty node types".

A handful of OpenSCAD operations have no build123d equivalent, most notably 3D
`hull` and general `minkowski`. Those emit a call to a helper that raises, so
generated code is never silently wrong about geometry, and they are reported as
unsupported operations so a caller can show coverage before the code is run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
from typing import Any

MAX_CSG_BYTES = 32 * 1024 * 1024
MAX_CSG_NODES = 200_000
MAX_CSG_DEPTH = 500

_TOKEN = re.compile(
    r"""
    (?P<space>\s+)
  | (?P<number>-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|-?inf|nan)
  | (?P<ident>[A-Za-z_$][A-Za-z0-9_]*)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<punct>[(){}\[\],=;])
    """,
    re.VERBOSE,
)

# OpenSCAD nodes that only wrap their children.
_PASSTHROUGH = frozenset({"group", "render", "color"})


class ScadConversionError(ValueError):
    pass


@dataclass
class CsgNode:
    name: str
    positional: list[Any] = field(default_factory=list)
    named: dict[str, Any] = field(default_factory=dict)
    children: list[CsgNode] = field(default_factory=list)


@dataclass
class ConversionResult:
    source: str
    node_count: int
    converted_nodes: int
    unsupported: list[str]

    @property
    def coverage(self) -> float:
        if not self.node_count:
            return 1.0
        return self.converted_nodes / self.node_count


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def _tokenize(text: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    position = 0
    length = len(text)
    while position < length:
        match = _TOKEN.match(text, position)
        if match is None:
            snippet = text[position : position + 30].strip()
            raise ScadConversionError(f"Unexpected characters in CSG output near {snippet!r}.")
        position = match.end()
        kind = match.lastgroup
        if kind == "space":
            continue
        assert kind is not None
        tokens.append((kind, match.group()))
    return tokens


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]) -> None:
        self.tokens = tokens
        self.index = 0
        self.nodes = 0

    def _peek(self) -> tuple[str, str] | None:
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def _next(self) -> tuple[str, str]:
        token = self._peek()
        if token is None:
            raise ScadConversionError("CSG output ended unexpectedly.")
        self.index += 1
        return token

    def _expect(self, value: str) -> None:
        kind, text = self._next()
        if text != value:
            raise ScadConversionError(f"Expected {value!r} in CSG output but found {text!r}.")

    def parse_nodes(self, depth: int = 0) -> list[CsgNode]:
        if depth > MAX_CSG_DEPTH:
            raise ScadConversionError("CSG output is nested too deeply to convert.")
        nodes: list[CsgNode] = []
        while True:
            token = self._peek()
            if token is None or token[1] == "}":
                return nodes
            nodes.append(self._parse_node(depth))

    def _parse_node(self, depth: int) -> CsgNode:
        self.nodes += 1
        if self.nodes > MAX_CSG_NODES:
            raise ScadConversionError("CSG output contains too many nodes to convert.")
        kind, name = self._next()
        if kind != "ident":
            raise ScadConversionError(f"Expected a CSG operation but found {name!r}.")
        self._expect("(")
        positional, named = self._parse_arguments()
        node = CsgNode(name=name, positional=positional, named=named)
        token = self._peek()
        if token is not None and token[1] == "{":
            self._next()
            node.children = self.parse_nodes(depth + 1)
            self._expect("}")
        elif token is not None and token[1] == ";":
            self._next()
        return node

    def _parse_arguments(self) -> tuple[list[Any], dict[str, Any]]:
        positional: list[Any] = []
        named: dict[str, Any] = {}
        if self._peek() is not None and self._peek()[1] == ")":  # type: ignore[index]
            self._next()
            return positional, named
        while True:
            token = self._peek()
            if token is None:
                raise ScadConversionError("CSG arguments ended unexpectedly.")
            if token[0] == "ident" and self.index + 1 < len(self.tokens) and self.tokens[self.index + 1][1] == "=":
                self._next()
                self._next()
                named[token[1]] = self._parse_value()
            else:
                positional.append(self._parse_value())
            kind, text = self._next()
            if text == ")":
                return positional, named
            if text != ",":
                raise ScadConversionError(f"Expected ',' or ')' in CSG arguments but found {text!r}.")

    def _parse_value(self) -> Any:
        kind, text = self._next()
        if text == "[":
            values: list[Any] = []
            if self._peek() is not None and self._peek()[1] == "]":  # type: ignore[index]
                self._next()
                return values
            while True:
                values.append(self._parse_value())
                _, separator = self._next()
                if separator == "]":
                    return values
                if separator != ",":
                    raise ScadConversionError(f"Expected ',' or ']' in a CSG vector but found {separator!r}.")
        if kind == "number":
            return float(text)
        if kind == "string":
            return _decode_string(text)
        if text == "true":
            return True
        if text == "false":
            return False
        if text == "undef":
            return None
        return text


def _decode_string(text: str) -> str:
    body = text[1:-1]
    return re.sub(r"\\(.)", lambda match: {"n": "\n", "t": "\t"}.get(match.group(1), match.group(1)), body)


def parse_csg(text: str) -> CsgNode:
    """Parse OpenSCAD `csg` export output into a single root node."""
    if len(text.encode("utf-8")) > MAX_CSG_BYTES:
        raise ScadConversionError("The flattened CSG output is too large to convert.")
    parser = _Parser(_tokenize(text))
    nodes = parser.parse_nodes()
    if parser.index != len(parser.tokens):
        raise ScadConversionError("Trailing content in CSG output.")
    return CsgNode(name="group", children=nodes)


# --------------------------------------------------------------------------
# Emitting
# --------------------------------------------------------------------------


def _number(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScadConversionError(f"Expected a number in CSG output but found {value!r}.")
    if not math.isfinite(float(value)):
        raise ScadConversionError("The CSG output contains a non-finite number.")
    rounded = round(float(value), 6)
    if rounded == 0:
        return "0"
    text = format(rounded, ".6f").rstrip("0").rstrip(".")
    return text


def _pair(value: Any, fallback: float | None = None) -> tuple[float, float]:
    if isinstance(value, list) and len(value) >= 2:
        return float(value[0]), float(value[1])
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), float(value)
    if fallback is not None:
        return fallback, fallback
    raise ScadConversionError(f"Expected a 2D vector in CSG output but found {value!r}.")


def _triple(value: Any) -> tuple[float, float, float]:
    if isinstance(value, list) and len(value) >= 3:
        return float(value[0]), float(value[1]), float(value[2])
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), float(value), float(value)
    raise ScadConversionError(f"Expected a 3D vector in CSG output but found {value!r}.")


def _points(value: Any) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        raise ScadConversionError("Expected a point list in CSG output.")
    return [(float(point[0]), float(point[1])) for point in value if isinstance(point, list) and len(point) >= 2]


@dataclass
class _Value:
    """A named variable in the generated source, with the dimension it holds."""

    name: str
    dim: int


class _Emitter:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.counters: dict[str, int] = {}
        self.unsupported: list[str] = []
        self.total = 0

    def _name(self, prefix: str) -> str:
        self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return f"{prefix}_{self.counters[prefix]}"

    def _assign(self, prefix: str, expression: str, dim: int) -> _Value:
        name = self._name(prefix)
        self.lines.append(f"{name} = {expression}")
        return _Value(name, dim)

    def _mark_unsupported(self, operation: str, detail: str, dim: int) -> _Value:
        self.unsupported.append(f"{operation}: {detail}")
        name = self._name("unsupported")
        self.lines.append(f"# FIXME: {operation} — {detail}")
        self.lines.append(f'{name} = _unsupported("{operation}", "{detail}")')
        return _Value(name, dim)

    # -- traversal --------------------------------------------------------

    def visit(self, node: CsgNode) -> _Value | None:
        self.total += 1
        handler = getattr(self, f"_node_{node.name}", None)
        if handler is None:
            children = self._visit_children(node)
            return self._mark_unsupported(
                node.name,
                f"no build123d equivalent for OpenSCAD {node.name}()",
                children[0].dim if children else 3,
            )
        return handler(node)

    def _visit_all(self, node: CsgNode) -> list[_Value | None]:
        """Visit children keeping empties in place, for order-sensitive nodes."""
        return [self.visit(child) for child in node.children]

    def _visit_children(self, node: CsgNode) -> list[_Value]:
        return [value for value in self._visit_all(node) if value is not None]

    def _combine(self, values: list[_Value], operator: str, prefix: str) -> _Value | None:
        if not values:
            return None
        if len(values) == 1:
            return values[0]
        dim = values[0].dim
        expression = f" {operator} ".join(value.name for value in values)
        return self._assign(prefix, expression, dim)

    # -- structural nodes -------------------------------------------------

    def _node_group(self, node: CsgNode) -> _Value | None:
        return self._combine(self._visit_children(node), "+", "group")

    _node_render = _node_group
    _node_color = _node_group
    _node_union = _node_group

    def _node_difference(self, node: CsgNode) -> _Value | None:
        values = self._visit_all(node)
        # Position matters: everything is cut from the first child, so an empty
        # first child means the whole difference is empty rather than a union
        # of the remaining ones.
        if not values or values[0] is None:
            return None
        removed = [value for value in values[1:] if value is not None]
        if not removed:
            return values[0]
        expression = " - ".join(value.name for value in [values[0], *removed])
        return self._assign("cut", expression, values[0].dim)

    def _node_intersection(self, node: CsgNode) -> _Value | None:
        values = self._visit_all(node)
        if not values or any(value is None for value in values):
            return None
        return self._combine([value for value in values if value is not None], "&", "common")

    def _node_multmatrix(self, node: CsgNode) -> _Value | None:
        value = self._combine(self._visit_children(node), "+", "group")
        if value is None:
            return None
        rows = node.positional[0] if node.positional else None
        if not isinstance(rows, list) or len(rows) < 3:
            raise ScadConversionError("multmatrix() is missing its transformation matrix.")
        matrix = [[float(cell) for cell in row] for row in rows[:3]]
        if _is_identity(matrix):
            return value
        translation = _pure_translation(matrix)
        if translation is not None:
            x, y, z = translation
            placed = f"Pos({_number(x)}, {_number(y)}, {_number(z)}) * {value.name}"
            return self._assign("moved", placed, value.dim)
        body = ", ".join("[" + ", ".join(_number(cell) for cell in row) + "]" for row in matrix)
        return self._assign("xf", f"{value.name}.transform_geometry(Matrix([{body}]))", value.dim)

    # -- 3D primitives ----------------------------------------------------

    def _node_cube(self, node: CsgNode) -> _Value | None:
        x, y, z = _triple(node.named.get("size", 1))
        if min(x, y, z) <= 0:
            return None
        align = "Align.CENTER" if node.named.get("center") else "Align.MIN"
        expression = f"Box({_number(x)}, {_number(y)}, {_number(z)}, align=({align}, {align}, {align}))"
        return self._assign("box", expression, 3)

    def _node_sphere(self, node: CsgNode) -> _Value | None:
        radius = float(node.named.get("r", 1))
        if radius <= 0:
            return None
        return self._assign("sphere", f"Sphere({_number(radius)})", 3)

    def _node_cylinder(self, node: CsgNode) -> _Value | None:
        height = float(node.named.get("h", 1))
        bottom = float(node.named.get("r1", node.named.get("r", 1)))
        top = float(node.named.get("r2", node.named.get("r", 1)))
        if height <= 0 or max(bottom, top) <= 0:
            return None
        z_align = "Align.CENTER" if node.named.get("center") else "Align.MIN"
        align = f"align=(Align.CENTER, Align.CENTER, {z_align})"
        if math.isclose(bottom, top):
            expression = f"Cylinder({_number(bottom)}, {_number(height)}, {align})"
        else:
            expression = f"Cone({_number(bottom)}, {_number(top)}, {_number(height)}, {align})"
        return self._assign("cyl", expression, 3)

    # -- 2D primitives ----------------------------------------------------

    def _node_square(self, node: CsgNode) -> _Value | None:
        width, height = _pair(node.named.get("size", 1))
        if width <= 0 or height <= 0:
            return None
        align = "Align.CENTER" if node.named.get("center") else "Align.MIN"
        expression = f"Rectangle({_number(width)}, {_number(height)}, align=({align}, {align}))"
        return self._assign("rect", expression, 2)

    def _node_circle(self, node: CsgNode) -> _Value | None:
        radius = float(node.named.get("r", 1))
        if radius <= 0:
            return None
        return self._assign("circle", f"Circle({_number(radius)})", 2)

    def _node_polygon(self, node: CsgNode) -> _Value | None:
        points = _points(node.named.get("points"))
        if len(points) < 3:
            return None
        if node.named.get("paths"):
            return self._mark_unsupported(
                "polygon",
                "multi-contour polygons with explicit paths are not converted",
                2,
            )
        body = ", ".join(f"({_number(x)}, {_number(y)})" for x, y in points)
        expression = f"Polygon([{body}], align=None)"
        return self._assign("poly", expression, 2)

    def _node_text(self, node: CsgNode) -> _Value | None:
        text = node.named.get("text", "")
        size = float(node.named.get("size", 10))
        font = node.named.get("font") or "Arial"
        expression = f"Text({text!r}, {_number(size)}, font={font!r})"
        return self._assign("text", expression, 2)

    # -- 2D to 3D ---------------------------------------------------------

    def _node_linear_extrude(self, node: CsgNode) -> _Value | None:
        profile = self._combine(self._visit_children(node), "+", "profile")
        if profile is None:
            return None
        height = float(node.named.get("height", 1))
        if height <= 0:
            return None
        if float(node.named.get("twist", 0) or 0):
            return self._mark_unsupported(
                "linear_extrude",
                "twisted extrusions are not converted",
                3,
            )
        centered = bool(node.named.get("center"))
        scale_x, scale_y = _pair(node.named.get("scale", 1), fallback=1.0)
        if math.isclose(scale_x, 1) and math.isclose(scale_y, 1):
            if centered:
                expression = f"extrude({profile.name}, amount={_number(height / 2)}, both=True)"
            else:
                expression = f"extrude({profile.name}, amount={_number(height)})"
            return self._assign("solid", expression, 3)
        # A tapered OpenSCAD extrude scales the profile rather than applying a
        # constant draft angle, so it lofts between the two profiles instead.
        base = profile.name
        top = self._assign(
            "top",
            f"Pos(0, 0, {_number(height)}) * scale({base}, by=({_number(scale_x)}, {_number(scale_y)}, 1))",
            2,
        )
        lofted = self._assign("solid", f"loft([{base}, {top.name}])", 3)
        if not centered:
            return lofted
        return self._assign("solid", f"Pos(0, 0, {_number(-height / 2)}) * {lofted.name}", 3)

    def _node_rotate_extrude(self, node: CsgNode) -> _Value | None:
        profile = self._combine(self._visit_children(node), "+", "profile")
        if profile is None:
            return None
        angle = float(node.named.get("angle", 360) or 360)
        # OpenSCAD revolves an XY profile about Z, treating profile x as radius
        # and profile y as height, which is the XZ plane in build123d.
        placed = self._assign("profile", f"Plane.XZ * {profile.name}", 2)
        expression = f"revolve({placed.name}, Axis.Z, revolution_arc={_number(abs(angle))})"
        return self._assign("solid", expression, 3)

    # -- modifiers --------------------------------------------------------

    def _node_offset(self, node: CsgNode) -> _Value | None:
        value = self._combine(self._visit_children(node), "+", "profile")
        if value is None:
            return None
        radius = node.named.get("r")
        delta = node.named.get("delta")
        if radius is not None and float(radius):
            amount, kind = float(radius), "Kind.ARC"
        elif delta is not None and float(delta):
            amount = float(delta)
            kind = "Kind.TANGENT" if node.named.get("chamfer") else "Kind.INTERSECTION"
        else:
            return value
        expression = f"offset({value.name}, amount={_number(amount)}, kind={kind})"
        return self._assign("grown", expression, value.dim)

    def _node_hull(self, node: CsgNode) -> _Value | None:
        value = self._combine(self._visit_children(node), "+", "group")
        if value is None:
            return None
        if value.dim == 2:
            return self._assign("hull", f"make_hull({value.name}.edges())", 2)
        return self._mark_unsupported(
            "hull",
            "3D convex hulls have no build123d equivalent",
            3,
        )

    def _node_minkowski(self, node: CsgNode) -> _Value | None:
        values = self._visit_all(node)
        if not values or values[0] is None:
            return None
        radius = _sphere_radius(node)
        if len(values) == 2 and radius is not None:
            # Minkowski with a sphere is a uniform 3D offset, which does map.
            expression = f"offset({values[0].name}, amount={_number(radius)}, kind=Kind.ARC)"
            return self._assign("rounded", expression, values[0].dim)
        return self._mark_unsupported(
            "minkowski",
            "general Minkowski sums have no build123d equivalent",
            values[0].dim,
        )


def _sphere_radius(node: CsgNode) -> float | None:
    """Return the radius when a minkowski()'s second operand is a plain sphere."""
    if len(node.children) != 2:
        return None
    candidate = node.children[1]
    while candidate.name in _PASSTHROUGH and len(candidate.children) == 1:
        candidate = candidate.children[0]
    if candidate.name != "sphere":
        return None
    radius = candidate.named.get("r")
    return float(radius) if isinstance(radius, (int, float)) and not isinstance(radius, bool) else None


def _is_identity(matrix: list[list[float]]) -> bool:
    expected = [[1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0]]
    return all(
        math.isclose(cell, expected[row][column], abs_tol=1e-9)
        for row, line in enumerate(matrix)
        for column, cell in enumerate(line)
    )


def _pure_translation(matrix: list[list[float]]) -> tuple[float, float, float] | None:
    rotation = [row[:3] for row in matrix]
    identity = [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
    for row, line in enumerate(rotation):
        for column, cell in enumerate(line):
            if not math.isclose(cell, identity[row][column], abs_tol=1e-9):
                return None
    return matrix[0][3], matrix[1][3], matrix[2][3]


_DOCSTRING = '''"""Generated from OpenSCAD by Klippee.

OpenSCAD flattened the original script to a CSG tree, which was then translated
to build123d. Review the geometry before relying on it; any FIXME below marks an
OpenSCAD operation with no build123d equivalent.
"""'''

_HELPER = '''def _unsupported(operation: str, detail: str):
    raise NotImplementedError(f"{operation} could not be converted: {detail}")'''

_SYMBOLS = (
    "Align",
    "Axis",
    "Box",
    "Circle",
    "Cone",
    "Cylinder",
    "Kind",
    "Matrix",
    "Plane",
    "Polygon",
    "Pos",
    "Rectangle",
    "Sphere",
    "Text",
    "extrude",
    "loft",
    "make_hull",
    "offset",
    "revolve",
    "scale",
)


def emit_build123d(root: CsgNode) -> ConversionResult:
    emitter = _Emitter()
    result = emitter.visit(root)
    body = list(emitter.lines or ["# The OpenSCAD script produced no geometry."])
    body.append("")
    body.append(f"result = {result.name}" if result is not None else "result = None")
    text = "\n".join(body)

    # Import only what the generated body actually references, so the output
    # passes a linter without hand editing.
    used = [symbol for symbol in _SYMBOLS if re.search(rf"\b{symbol}\b", text)]
    lines = [_DOCSTRING, ""]
    if used:
        lines.append("from build123d import (")
        lines.extend(f"    {symbol}," for symbol in used)
        lines.append(")")
        lines.append("")
    if emitter.unsupported:
        lines.extend(["", _HELPER, ""])
    lines.append("")
    lines.append(text)
    # A node that legitimately yields no geometry, such as an empty group or a
    # degenerate square, is still converted; only an unsupported marker is not.
    return ConversionResult(
        source="\n".join(lines) + "\n",
        node_count=emitter.total,
        converted_nodes=emitter.total - len(emitter.unsupported),
        unsupported=emitter.unsupported,
    )


def convert_csg(text: str) -> ConversionResult:
    """Convert OpenSCAD `csg` export output into build123d source."""
    return emit_build123d(parse_csg(text))
