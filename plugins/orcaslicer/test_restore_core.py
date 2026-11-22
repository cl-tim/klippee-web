"""Restore trust boundary and non-destructive native-loader contracts."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from capture_core import capture
from restore_core import validate_restore, restore_setup, restore_user_directory, plan_import, comparison_keys
from test_preset_spike import fixture, Preset


class RestoreTests(unittest.TestCase):
    def test_individual_profile_copies_only_its_full_ancestry(self):
        original = capture(fixture())
        for selection in original["selections"]:
            nodes = {}; cursor = selection["node"]
            while cursor:
                nodes[cursor] = deepcopy(original["nodes"][cursor]); cursor = nodes[cursor]["parent"]
            selected = {"node": selection["node"], "slot": None, "dirty": False,
                        "effective": deepcopy(nodes[selection["node"]]["saved"]), "changes": {}}
            snapshot = {"format": "klippee-orca-profile/v1", "nodes": nodes, "selections": [selected]}
            clean = validate_restore({"snapshot": snapshot})
            stages, expected = plan_import(clean, "individual-profile", friendly=True)
            self.assertEqual(len(expected), 1)
            self.assertEqual(sum(len(stage["files"]) - 1 for stage in stages), len(nodes) + 1)
            self.assertEqual(next(iter(expected)).split(":")[0], nodes[selection["node"]]["kind"])
            selected["effective"]["value"] = "edited"
            with self.assertRaises(ValueError):
                validate_restore({"snapshot": snapshot})

    def test_omitted_credentials_use_native_defaults_but_slicing_settings_must_match(self):
        self.assertEqual(comparison_keys({"print_host": "", "host_type": "0", "layer_height": "0.2"},
                                         {"layer_height": "0.2"}), {"layer_height"})
        self.assertIn("layer_height", comparison_keys({"layer_height": "0.2"}, {}))

    def snapshot(self):
        snapshot = capture(fixture())
        fourth = deepcopy(snapshot["selections"][2])
        fourth.update(slot=3, dirty=True)
        fourth["effective"]["value"] = "different fourth-slot edit"
        snapshot["selections"].append(fourth)
        return snapshot

    def test_recomputes_deltas_and_preserves_four_ordered_independent_slots(self):
        snapshot = self.snapshot()
        snapshot["selections"][-1]["changes"] = {"malicious_option": "ignored"}
        clean = validate_restore({"snapshot": snapshot})
        stages, expected = plan_import(clean, "restore-test", friendly=True)
        self.assertEqual([s["slot"] for s in clean["selections"]], [None, None, 0, 1, 2, 3])
        self.assertEqual(len(expected), 6)
        self.assertEqual(list(expected.values())[-1]["value"], "different fourth-slot edit")
        text = json.dumps(stages)
        self.assertNotIn("malicious_option", text)
        self.assertIn("different fourth-slot edit", text)
        self.assertNotEqual(list(expected)[2], list(expected)[-1])

    def test_rejects_invalid_graphs_slots_and_missing_effective_settings(self):
        original = self.snapshot()
        mutations = [
            lambda s: s["nodes"]["machine:Printer"].update(parent="machine:missing"),
            lambda s: s["nodes"]["machine:Base Printer"].update(parent=[]),
            lambda s: s["nodes"]["machine:Printer"].update(parent="process:Process"),
            lambda s: s["selections"][-1].update(slot=0),
            lambda s: s["selections"][-1].update(slot=True),
            lambda s: s["selections"][0]["effective"].pop("untouched"),
            lambda s: s["selections"][0]["effective"].update(inherits="another parent"),
            lambda s: s["nodes"]["machine:Printer"].update(source_json=[]),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                snapshot = deepcopy(original)
                mutate(snapshot)
                with self.assertRaises(ValueError):
                    validate_restore({"snapshot": snapshot})
        cycle = deepcopy(original)
        cycle["nodes"]["machine:Base Printer"]["parent"] = "machine:Printer"
        cycle["nodes"]["machine:Base Printer"]["saved"]["inherits"] = "Printer"
        with self.assertRaisesRegex(ValueError, "cyclic"):
            validate_restore({"snapshot": cycle})

    def test_unrelated_presets_and_bad_bundle_paths_are_rejected(self):
        snapshot = self.snapshot()
        snapshot["nodes"]["machine:Unused"] = {"kind": "machine", "name": "Unused", "parent": None,
                                               "saved": {}, "source_json": None}
        with self.assertRaisesRegex(ValueError, "unrelated"):
            validate_restore({"snapshot": snapshot})
        for name in ("../outside", "C:/outside", "UPPER", ""):
            with self.assertRaises(ValueError):
                plan_import(self.snapshot(), name, friendly=True)

    def test_restore_adds_copies_parent_first_and_keeps_active_edits_and_originals(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            storage = root / "orca_plugins/plugin_data/klippee"
            storage.mkdir(parents=True)
            bundle = fixture()
            original = root / "user/default/machine/Printer.json"
            original.parent.mkdir(parents=True)
            original.write_text('{"original":"keep"}')
            bundle.printers.selected.file = str(original)
            snapshot = validate_restore({"snapshot": self.snapshot()})
            before = capture(bundle)
            loaded = []

            def reload_local(bundle_id):
                target = root / "user/default/_local" / bundle_id
                loaded.append(bundle_id)
                for kind, attr in (("machine", "printers"), ("process", "prints"), ("filament", "filaments")):
                    collection = getattr(bundle, attr)
                    for path in (target / kind).glob("*.json"):
                        document = json.loads(path.read_text())
                        parent = document["inherits"]
                        inherited = dict(collection.presets[parent].config) if parent else {}
                        inherited.update({k: v for k, v in document.items() if k not in {"name", "type", "version", "from"}})
                        name = "_local/" + bundle_id + "/" + document["name"]
                        collection.presets[name] = Preset(name, inherited, file=str(path))

            result = restore_setup(snapshot, bundle, storage, reload_local)
            self.assertEqual(len(result["names"]), 6)
            self.assertEqual(capture(bundle), before)
            self.assertEqual(original.read_text(), '{"original":"keep"}')
            self.assertEqual([name.rsplit("-d", 1)[1] for name in loaded], ["0", "1", "2"])
            second = restore_setup(snapshot, bundle, storage, reload_local)
            self.assertNotEqual(result["names"], second["names"])
            self.assertEqual(capture(bundle), before)

    def test_unknown_user_folder_and_failed_reload_are_explicit(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            storage = root / "orca_plugins/plugin_data/klippee"
            storage.mkdir(parents=True)
            bundle = fixture()
            with self.assertRaisesRegex(ValueError, "saved user"):
                restore_user_directory(bundle, storage)
            original = root / "user/default/machine/Printer.json"
            original.parent.mkdir(parents=True)
            original.write_text('{}')
            bundle.printers.selected.file = str(original)
            def fail(_):
                raise OSError("native reload rejected")
            with self.assertRaisesRegex(ValueError, "Copies may remain"):
                restore_setup(validate_restore({"snapshot": self.snapshot()}), bundle, storage, fail)
            self.assertEqual(original.read_text(), '{}')


if __name__ == "__main__":
    unittest.main()
