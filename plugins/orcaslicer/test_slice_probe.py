"""Guard against a successful slice masking slot fallback or wrong settings."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import xml.etree.ElementTree as ET
import zipfile

from slice_probe import assign_slot, toolpath_evidence


class SliceProbeTests(unittest.TestCase):
    def evidence(self, text):
        filaments = [{"nozzle_temperature_initial_layer": "220", "nozzle_temperature": "221",
                      "hot_plate_temp_initial_layer": "55", "hot_plate_temp": "55"}] * 4
        return toolpath_evidence(text, 2, filaments,
                                 {"layer_height": "0.21", "initial_layer_print_height": "0.2"}, "hot_plate_temp")

    def text(self):
        return ("; filament used [mm] = 0, 0, 10, 0\nM104 S220\nM104 S221\nM140 S55\n"
                ";Z:0.2\nG1 X10 Y10 E0.1\n;Z:0.41\n;Z:0.62\n;Z:0.83\n")

    def test_commands_and_consumption_match_selected_slot(self):
        self.assertTrue(all(self.evidence(self.text())["checks"].values()))

    def test_detects_slot_fallback_even_with_correct_temperatures(self):
        text = self.text().replace("0, 0, 10, 0", "10, 0, 0, 0")
        self.assertFalse(self.evidence(text)["checks"]["only_requested_slot_extrudes"])

    def test_detects_wrong_layer_spacing_and_nozzle_command(self):
        text = self.text().replace(";Z:0.41", ";Z:0.4").replace("M104 S221", "M104 S230")
        checks = self.evidence(text)["checks"]
        self.assertFalse(checks["normal_layer_z_spacing"])
        self.assertFalse(checks["normal_nozzle_command"])

    def test_empty_output_cannot_pass(self):
        self.assertFalse(any(self.evidence("")["checks"].values()))

    def test_assignment_preserves_project_settings_and_all_four_slots(self):
        with TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.3mf", Path(directory) / "target.3mf"
            config = json.dumps({"filament_settings_id": ["a", "b", "c", "d"], "layer_height": "0.21"}).encode()
            model = '<config><object id="1"><metadata key="extruder" value="1"/><part id="1"><metadata key="extruder" value="1"/></part></object></config>'
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("Metadata/model_settings.config", model)
                archive.writestr("Metadata/project_settings.config", config)
                archive.writestr("3D/3dmodel.model", b"unchanged geometry")
            assign_slot(source, target, 3)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.read("Metadata/project_settings.config"), config)
                self.assertEqual(archive.read("3D/3dmodel.model"), b"unchanged geometry")
                tree = ET.fromstring(archive.read("Metadata/model_settings.config"))
                self.assertEqual([item.get("value") for item in tree.findall(".//metadata[@key='extruder']")], ["4", "4"])


if __name__ == "__main__":
    unittest.main()
