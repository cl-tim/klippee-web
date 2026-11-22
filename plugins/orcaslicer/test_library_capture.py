"""Catalog scope, inheritance and active edits are independent of device links."""
from copy import deepcopy
import unittest
from capture_core import capture
from klippee_plugin import sanitize_capture, make_request
from test_preset_spike import fixture, Preset
from test_plugin_lifecycle import bridge_module


class LibraryTests(unittest.TestCase):
    def test_library_bridge_reviews_and_saves_unselected_profiles_and_detects_stale_catalog(self):
        module, page, bundle = bridge_module()
        bundle.filaments.presets["Unused Custom Filament"] = Preset("Unused Custom Filament", {"inherits": "Base Filament", "value": "unused"})
        for attr in ("printers", "prints", "filaments"):
            for preset in getattr(bundle, attr).presets.values():
                preset.is_user = lambda: True
                preset.is_visible, preset.is_default = True, False
        module.orca.host.app_info = lambda: {"version": "2.5.0-alpha", "build": "test"}
        requests = []
        page.start_request = lambda *args: requests.append(args)
        page.on_message({"command": "review", "code": "https://klippee.xyz/#klorca_" + "x" * 43})
        page.results.put({"command": "connected", "data": {"scope": "library", "printerName": "your profile library"}})
        page.advance()
        self.assertEqual(page.message["command"], "connected")
        self.assertIn("Unused Custom Filament", [p["name"] for p in page.message["profiles"]])
        page.on_message({"command": "save", "title": "Library import"})
        self.assertEqual(requests[-1][2], "/api/orca/library")
        self.assertNotIn("snapshot", requests[-1][3])
        self.assertIn("current", requests[-1][3]["library"])
        bundle.filaments.presets["Unused Custom Filament"].config["value"] = "changed unselected profile"
        page.on_message({"command": "save", "title": "Library import"})
        self.assertEqual(page.message["command"], "error")
        self.assertIn("changed after review", page.message["error"])
        self.assertEqual(len(requests), 2)

    def test_saved_connection_reviews_each_upload_and_preserves_confirmation_and_stale_edit_checks(self):
        for command, scope, path in [("review_saved_library", "library", "/api/orca/library"), ("review_saved_setup", "setup", "/api/orca/capture")]:
            module, page, bundle = bridge_module()
            for attr in ("printers", "prints", "filaments"):
                for preset in getattr(bundle, attr).presets.values():
                    preset.is_user = lambda: True
                    preset.is_visible, preset.is_default = True, False
            module.orca.host.app_info = lambda: {"version": "2.5.0-alpha", "build": "test"}
            device = "klorcadevice_" + "s" * 43
            page.browse_connection = ("https://klippee.xyz", device)
            requests = []
            page.start_request = lambda *args: requests.append(args)
            page.on_message({"command": command})
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0][2], "/api/orca/device/upload-connection")
            self.assertEqual(requests[0][3]["scope"], scope)
            self.assertNotEqual(requests[0][3]["token"], device)
            page.results.put({"command": "upload_authorized", "data": {"scope": scope, "printerName": "your library"}})
            page.advance()
            self.assertEqual(page.message["command"], "connected")
            self.assertNotIn(device, str(page.message))
            self.assertEqual(len(requests), 1, "Review must not upload")
            page.on_message({"command": "save", "title": "Reviewed setup"})
            self.assertEqual(requests[-1][2], path)
            self.assertNotEqual(requests[-1][1], device)
            bundle.printers.edited.config["value"] = "changed after review"
            page.on_message({"command": "save", "title": "Reviewed setup"})
            self.assertEqual(page.message["command"], "error")
            self.assertEqual(len(requests), 2)
            page.on_message({"command": "cancel"})
            self.assertEqual(page.browse_connection, ("https://klippee.xyz", device))
            page.on_message({"command": command})
            self.assertEqual(len(requests), 3)
            self.assertEqual(requests[-1][2], "/api/orca/device/upload-connection")

    def test_all_custom_profiles_and_enabled_printers_include_unselected_nozzles(self):
        bundle = fixture()
        for attr in ("printers", "prints", "filaments"):
            for preset in getattr(bundle, attr).presets.values():
                preset.is_user = lambda: False
                preset.is_visible = False
                preset.is_default = False
        for name, attr, custom, visible in [
            ("QIDI 0.2", "printers", True, True), ("QIDI 0.6", "printers", False, True),
            ("Hidden printer", "printers", False, False), ("Unused @System", "filaments", True, False),
            ("Unused process", "prints", True, False), ("Stock filament", "filaments", False, True),
        ]:
            parent = "Base " + {"printers": "Printer", "prints": "Process", "filaments": "Filament"}[attr]
            preset = Preset(name, {"inherits": parent, "api_key": "secret"})
            preset.is_user = lambda custom=custom: custom
            preset.is_visible, preset.is_default = visible, False
            getattr(bundle, attr).presets[name] = preset
        before = capture(bundle)
        library = capture(bundle, library=True)
        self.assertEqual([p["node"] for p in library["profiles"]],
                         ["machine:QIDI 0.2", "machine:QIDI 0.6", "process:Unused process", "filament:Unused @System"])
        self.assertEqual(library["current"], before)
        self.assertEqual(capture(bundle), before)
        self.assertIn("filament:Base Filament", library["nodes"])
        self.assertNotIn("machine:Hidden printer", library["nodes"])
        clean, omitted = sanitize_capture(library)
        self.assertIn("api_key", omitted)
        self.assertNotIn("api_key", clean["nodes"]["filament:Unused @System"]["saved"])
        saved = deepcopy(clean)
        bundle.prints.edited.config["value"] = "another edit"
        self.assertEqual(clean, saved)
        self.assertNotEqual(sanitize_capture(capture(bundle, library=True))[0], clean)

    def test_library_transport_has_a_separate_bounded_payload_limit(self):
        request = make_request("https://klippee.xyz", "unused", "/api/orca/library", {"large": "x" * 600_000})
        self.assertGreater(len(request.data), 512_000)
        with self.assertRaisesRegex(ValueError, "too large"):
            make_request("https://klippee.xyz", "unused", "/api/orca/library", {"large": "x" * 8_000_000})
