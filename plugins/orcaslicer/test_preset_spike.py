"""Contract tests; native loader proof is recorded separately in result.json."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from preset_spike import canonical_value, capture, import_graph, plan_import, saved_expectations, verify, verify_graph, values


def planned_files(snapshot, bundle_id="test"):
    stages, expected = plan_import(snapshot, bundle_id)
    files = {name: document for stage in stages for name, document in stage["files"].items()
             if name != "bundle_metadata.json"}
    files["bundle_metadata.json"] = stages[-1]["files"]["bundle_metadata.json"]
    return files, expected


class Preset:
    def __init__(self, name, config, file="", dirty=False):
        self.name, self.config, self.file, self.is_dirty = name, config, file, dirty

    def config_keys(self):
        return list(self.config)

    def config_value(self, key):
        return self.config.get(key)


class Collection:
    def __init__(self, presets, selected, edited=None):
        self.presets = {preset.name: preset for preset in presets}
        self.selected = selected
        self.edited = edited or selected

    def find_preset(self, name):
        return self.presets.get(name)

    def size(self):
        return len(self.presets)

    def preset(self, index):
        return list(self.presets.values())[index]

    def get_selected_preset(self):
        return self.selected

    def get_edited_preset(self):
        return self.edited


def fixture():
    bundle = SimpleNamespace()
    for attr, label in (("printers", "Printer"), ("prints", "Process"), ("filaments", "Filament")):
        base = Preset("Base " + label, {"inherits": "", "value": "base"})
        saved = Preset(label, {"inherits": base.name, "value": "saved", "untouched": "1"})
        edited = Preset(label, {**saved.config, "value": "edited"}, dirty=True)
        setattr(bundle, attr, Collection([base, saved], saved, edited))
    second = Preset("Second Filament", {"inherits": "Base Filament", "value": "second"})
    bundle.filaments.presets[second.name] = second
    bundle.current_filament_presets = lambda: [bundle.filaments.edited, second, bundle.filaments.edited]
    return bundle


class CaptureTests(unittest.TestCase):
    def test_captures_live_edit_buffers_and_preserves_filament_slot_order(self):
        bundle = fixture()
        snapshot = capture(bundle)
        selections = snapshot["selections"]
        self.assertEqual([item["changes"] for item in selections],
                         [{"value": "edited"}, {"value": "edited"}, {"value": "edited"}, {}, {"value": "edited"}])
        self.assertEqual([item["slot"] for item in selections], [None, None, 0, 1, 2])
        self.assertEqual(snapshot["nodes"]["filament:Filament"]["saved"]["value"], "saved")
        # The result must be independent of the next UI edit.
        bundle.filaments.edited.config["value"] = "later edit"
        self.assertEqual(selections[2]["effective"]["value"], "edited")

    def test_preserves_unknown_json_and_original_value_shapes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            source = {"inherits": "Base Filament", "nozzle_temperature": ["210"],
                      "future_extension": {"nested": [1, True]}, "description": "line one\nline two"}
            path.write_text(json.dumps(source), encoding="utf-8")
            bundle = fixture()
            bundle.filaments.selected.file = str(path)
            snapshot = capture(bundle)
            files, _ = planned_files(snapshot)
            saved_files = [doc for name, doc in files.items() if name.startswith("filament/saved-")]
            copied = next(doc for doc in saved_files if "future_extension" in doc)
            self.assertEqual(copied["future_extension"], source["future_extension"])
            self.assertEqual(copied["nozzle_temperature"], ["210"])
            self.assertEqual(copied["description"], source["description"])

    def test_missing_and_cyclic_ancestry_fail_explicitly(self):
        bundle = fixture()
        del bundle.prints.presets["Base Process"]
        with self.assertRaisesRegex(ValueError, "Missing parent"):
            capture(bundle)
        bundle = fixture()
        bundle.prints.presets["Base Process"].config["inherits"] = "Process"
        with self.assertRaisesRegex(ValueError, "Cyclic"):
            capture(bundle)

    def test_rejects_missing_slots_and_unreadable_source_json(self):
        bundle = fixture()
        bundle.current_filament_presets = lambda: [None]
        with self.assertRaisesRegex(ValueError, "Missing filament"):
            capture(bundle)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            path.write_text("broken JSON")
            bundle = fixture()
            bundle.prints.selected.file = str(path)
            with self.assertRaises(json.JSONDecodeError):
                capture(bundle)

    def test_added_live_keys_are_captured_and_removed_keys_fail(self):
        bundle = fixture()
        bundle.prints.edited.config["new_option"] = "new"
        snapshot = capture(bundle)
        self.assertEqual(snapshot["selections"][1]["changes"]["new_option"], "new")
        del bundle.prints.edited.config["untouched"]
        with self.assertRaisesRegex(ValueError, "removed keys"):
            capture(bundle)


class ImportTests(unittest.TestCase):
    def test_unsaved_overrides_are_children_and_saved_inheritance_stays_sparse(self):
        snapshot = capture(fixture())
        original = deepcopy(snapshot)
        files, expected = planned_files(snapshot)
        child = files["process/captured-1-" + next(name.split("/")[1][:-5] for name in files
                                                  if name.startswith("process/saved-") and files[name]["inherits"]) + ".json"]
        self.assertEqual(child["value"], "edited")
        self.assertNotIn("untouched", child)
        self.assertTrue(child["inherits"].startswith("_local/test-d1/saved-"))
        self.assertEqual(len(expected), 5)
        self.assertEqual(snapshot, original)
        self.assertIn("bundle_metadata.json", files)

    def test_serialized_vectors_and_multiline_gcode_are_not_split_or_decoded(self):
        bundle = fixture()
        for value in ('210,220', '"M117 hello; world\\nG92 E0";"second"', '1x2,3x4', 'nil,0'):
            bundle.filaments.edited.config["value"] = value
            files, _ = planned_files(capture(bundle))
            child = next(doc for name, doc in files.items() if name.startswith("filament/captured-2-"))
            self.assertEqual(child["value"], value)

    def test_rejects_path_traversal_and_incomplete_capture(self):
        snapshot = capture(fixture())
        for name in ("", "../other", "C:/other", "a/b", "a\\b"):
            with self.assertRaises(ValueError):
                plan_import(snapshot, name)
        del snapshot["nodes"]["process:Base Process"]
        with self.assertRaisesRegex(ValueError, "Missing captured parent"):
            plan_import(snapshot, "test")

    def test_every_parent_is_in_an_earlier_reload_stage(self):
        stages, _ = plan_import(capture(fixture()), "test")
        loaded = set()
        for stage in stages:
            pending = set()
            for name, document in stage["files"].items():
                if name == "bundle_metadata.json":
                    continue
                if document["inherits"]:
                    self.assertIn(document["inherits"], loaded)
                pending.add("_local/" + stage["bundle_id"] + "/" + document["name"])
            loaded.update(pending)

    def test_project_loaded_values_override_stale_source_files_without_flattening(self):
        snapshot = capture(fixture())
        node = snapshot["nodes"]["filament:Filament"]
        node["source_json"] = {"inherits": "Base Filament", "value": "stale disk value"}
        files, _ = planned_files(snapshot)
        imported = next(doc for name, doc in files.items()
                        if name.startswith("filament/saved-") and doc.get("value") == "saved")
        self.assertTrue(imported["inherits"].startswith("_local/test-d0/"))
        self.assertEqual(node["source_json"]["value"], "stale disk value")

    def test_verification_detects_lost_values_missing_keys_and_missing_presets(self):
        bundle = fixture()
        wanted = values(bundle.prints.selected)
        wanted["value"] = "lost edit"
        wanted["missing"] = "needed"
        failures = verify(bundle, {"process:Process": wanted, "filament:Absent": {}})
        self.assertEqual({row.get("key", row.get("error")) for row in failures},
                         {"value", "missing", "not loaded"})

    def test_thumbnail_normalization_only_ignores_separator_whitespace(self):
        self.assertEqual(canonical_value("thumbnails", "48x48/PNG, 300x300/PNG"),
                         canonical_value("thumbnails", "48x48/PNG,300x300/PNG"))
        self.assertNotEqual(canonical_value("thumbnails", "48x48/PNG,300x300/PNG"),
                            canonical_value("thumbnails", "48x48/PNG,200x200/PNG"))
        self.assertNotEqual(canonical_value("machine_start_gcode", "G28\n"),
                            canonical_value("machine_start_gcode", "G28"))

    def test_restart_graph_checks_every_ancestor_and_edge(self):
        bundle = fixture()
        graph = {"process:Process": "Base Process", "process:Base Process": ""}
        self.assertEqual(verify_graph(bundle, graph), [])
        bundle.prints.presets["Process"].config["inherits"] = "Other Parent"
        self.assertEqual(verify_graph(bundle, graph)[0]["error"], "inheritance edge changed")
        del bundle.prints.presets["Base Process"]
        self.assertIn("ancestry node missing", [failure["error"] for failure in verify_graph(bundle, graph)])

    def test_ancestor_expectations_cover_all_copied_saved_presets(self):
        snapshot = capture(fixture())
        stages, leaves = plan_import(snapshot, "restart-test")
        graph = import_graph(stages)
        ancestors = saved_expectations(snapshot, graph)
        self.assertEqual(len(ancestors), len(snapshot["nodes"]))
        self.assertEqual(set(graph), set(ancestors) | set(leaves))
        for identity, config in ancestors.items():
            self.assertEqual(config["inherits"], graph[identity])

    def test_compatibility_tracks_copied_descendants_without_widening_conditions(self):
        snapshot = capture(fixture())
        for node in snapshot["nodes"].values():
            if node["kind"] == "process":
                node["saved"]["compatible_printers"] = '"Base Printer";Unrelated'
        snapshot["selections"][1]["effective"]["compatible_printers"] = '"Base Printer";Unrelated'
        stages, leaves = plan_import(snapshot, "compatibility-test")
        graph = import_graph(stages)
        printers = [key.split(":", 1)[1] for key in graph if key.startswith("machine:")]
        process = next(config for key, config in leaves.items() if key.startswith("process:"))
        self.assertTrue(process["compatible_printers"].startswith('"Base Printer";Unrelated;'))
        for printer in printers:
            self.assertIn(printer, process["compatible_printers"].split(";"))
        ancestors = saved_expectations(snapshot, graph)
        for key, config in ancestors.items():
            if key.startswith("process:"):
                self.assertEqual(config["compatible_printers"], process["compatible_printers"])
        self.assertNotIn("compatible_printers", next(config for key, config in leaves.items() if key.startswith("filament:")))

    def test_restart_verification_rejects_name_fallbacks(self):
        bundle = fixture()
        bundle.prints.find_preset = lambda name: bundle.prints.selected
        self.assertEqual(verify(bundle, {"process:Missing Copy": values(bundle.prints.selected)})[0]["error"],
                         "not loaded")
        self.assertEqual(verify_graph(bundle, {"process:Missing Copy": "Base Process"})[0]["error"],
                         "ancestry node missing")


if __name__ == "__main__":
    unittest.main()
