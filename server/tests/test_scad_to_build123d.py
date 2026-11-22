from __future__ import annotations

import ast
import unittest

from server.scad_to_build123d import ScadConversionError, convert_csg, parse_csg


def convert(csg: str):
    result = convert_csg(csg)
    ast.parse(result.source)  # generated source must always be valid Python
    return result


class CsgParsingTests(unittest.TestCase):
    def test_parses_named_and_positional_arguments(self) -> None:
        root = parse_csg("cube(size = [1, 2, 3], center = true);")
        node = root.children[0]
        self.assertEqual(node.name, "cube")
        self.assertEqual(node.named["size"], [1.0, 2.0, 3.0])
        self.assertIs(node.named["center"], True)

    def test_parses_undef_special_variables_and_nesting(self) -> None:
        root = parse_csg(
            "group() { polygon(points = [[0, 0]], paths = undef, convexity = 1); "
            "circle($fn = 24, r = 2.5); }"
        )
        polygon, circle = root.children[0].children
        self.assertIsNone(polygon.named["paths"])
        self.assertEqual(circle.named["$fn"], 24.0)

    def test_parses_negative_and_exponent_numbers(self) -> None:
        root = parse_csg("square(size = [-10.5, 2.5e-3], center = false);")
        self.assertEqual(root.children[0].named["size"], [-10.5, 0.0025])

    def test_rejects_malformed_output(self) -> None:
        with self.assertRaises(ScadConversionError):
            parse_csg("cube(size = [1, 2, 3]")


class PrimitiveConversionTests(unittest.TestCase):
    def test_cube_center_flag_selects_alignment(self) -> None:
        centered = convert("cube(size = [2, 4, 6], center = true);").source
        cornered = convert("cube(size = [2, 4, 6], center = false);").source
        self.assertIn("Box(2, 4, 6, align=(Align.CENTER, Align.CENTER, Align.CENTER))", centered)
        self.assertIn("Box(2, 4, 6, align=(Align.MIN, Align.MIN, Align.MIN))", cornered)

    def test_cylinder_with_unequal_radii_becomes_a_cone(self) -> None:
        source = convert("cylinder(h = 10, r1 = 4, r2 = 2, center = false);").source
        self.assertIn("Cone(4, 2, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))", source)

    def test_equal_radii_stay_a_cylinder(self) -> None:
        source = convert("cylinder(h = 10, r1 = 3, r2 = 3, center = true);").source
        self.assertIn("Cylinder(3, 10, align=(Align.CENTER, Align.CENTER, Align.CENTER))", source)

    def test_degenerate_shapes_are_dropped(self) -> None:
        # OpenSCAD tolerates zero and negative extents; build123d constructors do not.
        result = convert("group() { square(size = [0.95, 0], center = false); cube(size = [-1, 2, 3]); }")
        self.assertNotIn("Rectangle", result.source)
        self.assertNotIn("Box", result.source)
        self.assertIn("result = None", result.source)


class BooleanConversionTests(unittest.TestCase):
    def test_difference_subtracts_later_children(self) -> None:
        source = convert(
            "difference() { cube(size = [4, 4, 4]); cylinder(h = 9, r = 1); }"
        ).source
        self.assertRegex(source, r"cut_1 = box_1 - cyl_1")

    def test_difference_with_an_empty_first_child_is_empty(self) -> None:
        # The minuend's position matters: dropping it would wrongly union the rest.
        result = convert(
            "difference() { cube(size = [0, 4, 4]); cylinder(h = 9, r = 1); }"
        )
        self.assertIn("result = None", result.source)
        self.assertNotIn(" - ", result.source)

    def test_intersection_with_an_empty_child_is_empty(self) -> None:
        result = convert(
            "intersection() { cube(size = [4, 4, 4]); cube(size = [0, 0, 0]); }"
        )
        self.assertIn("result = None", result.source)

    def test_union_and_group_both_add(self) -> None:
        source = convert(
            "union() { cube(size = [1, 1, 1]); sphere(r = 1); }"
        ).source
        self.assertIn("box_1 + sphere_1", source)


class TransformConversionTests(unittest.TestCase):
    def test_identity_matrix_is_elided(self) -> None:
        source = convert(
            "multmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) "
            "{ cube(size = [1, 1, 1]); }"
        ).source
        self.assertNotIn("Pos(", source)
        self.assertNotIn("transform_geometry", source)

    def test_pure_translation_uses_pos(self) -> None:
        source = convert(
            "multmatrix([[1, 0, 0, 5], [0, 1, 0, -2], [0, 0, 1, 3], [0, 0, 0, 1]]) "
            "{ cube(size = [1, 1, 1]); }"
        ).source
        self.assertIn("Pos(5, -2, 3) * box_1", source)

    def test_rotation_uses_a_general_matrix(self) -> None:
        source = convert(
            "multmatrix([[0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) "
            "{ cube(size = [1, 1, 1]); }"
        ).source
        self.assertIn("transform_geometry(Matrix([[0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]))", source)


class ExtrudeConversionTests(unittest.TestCase):
    def test_centered_extrude_uses_both_directions(self) -> None:
        source = convert(
            "linear_extrude(height = 12, center = true, scale = [1, 1]) "
            "{ square(size = [2, 2], center = true); }"
        ).source
        self.assertIn("extrude(rect_1, amount=6, both=True)", source)

    def test_scaled_extrude_lofts_between_profiles(self) -> None:
        # OpenSCAD scales the profile rather than applying a constant draft angle.
        source = convert(
            "linear_extrude(height = 10, center = false, scale = [0.5, 0.5]) "
            "{ square(size = [4, 4], center = true); }"
        ).source
        self.assertIn("scale(rect_1, by=(0.5, 0.5, 1))", source)
        self.assertIn("loft([rect_1, top_1])", source)

    def test_rotate_extrude_revolves_on_the_xz_plane(self) -> None:
        source = convert("rotate_extrude(angle = 270) { circle(r = 2); }").source
        self.assertIn("Plane.XZ * circle_1", source)
        self.assertIn("revolve(profile_1, Axis.Z, revolution_arc=270)", source)

    def test_twisted_extrude_is_unsupported(self) -> None:
        result = convert(
            "linear_extrude(height = 10, twist = 90, scale = [1, 1]) { circle(r = 2); }"
        )
        self.assertTrue(any("twisted" in entry for entry in result.unsupported))


class UnsupportedOperationTests(unittest.TestCase):
    def test_two_dimensional_hull_is_supported(self) -> None:
        result = convert("hull() { circle(r = 1); circle(r = 2); }")
        self.assertEqual(result.unsupported, [])
        self.assertIn("make_hull(", result.source)

    def test_three_dimensional_hull_is_reported(self) -> None:
        result = convert("hull() { cube(size = [1, 1, 1]); sphere(r = 2); }")
        self.assertTrue(any(entry.startswith("hull:") for entry in result.unsupported))
        self.assertIn("_unsupported(", result.source)
        self.assertIn("# FIXME", result.source)

    def test_minkowski_with_a_sphere_becomes_an_offset(self) -> None:
        result = convert("minkowski() { cube(size = [4, 4, 4]); sphere(r = 1.5); }")
        self.assertEqual(result.unsupported, [])
        self.assertIn("offset(box_1, amount=1.5, kind=Kind.ARC)", result.source)

    def test_general_minkowski_is_reported(self) -> None:
        result = convert("minkowski() { cube(size = [4, 4, 4]); cylinder(h = 2, r = 1); }")
        self.assertTrue(any(entry.startswith("minkowski:") for entry in result.unsupported))

    def test_unknown_operations_are_reported_rather_than_dropped(self) -> None:
        result = convert("surface(file = \"terrain.dat\");")
        self.assertTrue(any(entry.startswith("surface:") for entry in result.unsupported))


class GeneratedSourceTests(unittest.TestCase):
    def test_imports_only_what_is_used(self) -> None:
        source = convert("cube(size = [1, 1, 1]);").source
        self.assertIn("Box,", source)
        for unused in ("Text,", "loft,", "make_hull,", "revolve,"):
            self.assertNotIn(unused, source)

    def test_helper_is_only_emitted_when_needed(self) -> None:
        self.assertNotIn("_unsupported", convert("cube(size = [1, 1, 1]);").source)
        self.assertIn("_unsupported", convert("hull() { cube(size = [1, 1, 1]); sphere(r = 1); }").source)

    def test_coverage_counts_only_unsupported_nodes(self) -> None:
        # Empty groups produce no geometry but are still converted.
        full = convert("group() { group() { } cube(size = [1, 1, 1]); }")
        self.assertEqual(full.coverage, 1.0)
        partial = convert("hull() { cube(size = [1, 1, 1]); sphere(r = 1); }")
        self.assertLess(partial.coverage, 1.0)
        self.assertGreater(partial.coverage, 0.0)


if __name__ == "__main__":
    unittest.main()
