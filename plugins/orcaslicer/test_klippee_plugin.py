"""Production capture transport and privacy checks; no printer communication."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from capture_core import capture
from klippee_plugin import NoRedirect, parse_connection, sanitize_capture, request_json
from test_preset_spike import fixture


def drain(page):
    deadline = time.monotonic() + 3
    while page.busy and time.monotonic() < deadline:
        page.on_message({"command": "poll"})
        time.sleep(0.001)
    assert not page.busy, "Operation did not finish"


class PluginTests(unittest.TestCase):
    def test_download_is_standalone_and_uses_the_shared_capture(self):
        path = Path(__file__).resolve().parents[2] / "public/install/klippee_orca.py"
        self.assertNotIn("from capture_core import", path.read_text(encoding="utf-8"))
        spec = importlib.util.spec_from_file_location("standalone_klippee_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.capture(fixture()), capture(fixture()))
        self.assertNotIn("\r\n", module._KLIPPEE_PAGE)

    def test_connection_code_requires_https_and_no_redirect_credentials(self):
        token = "klorca_" + "x" * 43
        self.assertEqual(parse_connection("https://klippee.xyz/#" + token), ("https://klippee.xyz", token))
        self.assertEqual(parse_connection("http://127.0.0.1:5173/#" + token)[0], "http://127.0.0.1:5173")
        for origin in ["http://example.com", "https://user:pass@example.com", "file://example.com", "https://example.com/path", "https://example.com/?query=x"]:
            with self.assertRaises(ValueError):
                parse_connection(origin + "/#" + token)
        with self.assertRaises(ValueError):
            parse_connection("https://klippee.xyz/#short")

    def test_secret_fields_are_removed_without_mutating_capture_or_gcode(self):
        original = capture(fixture())
        node = original["nodes"]["machine:Printer"]
        node["saved"].update(printhost_apikey="secret", machine_start_gcode="START_PRINT\nM117 hello")
        node["source_json"] = {"password": "secret", "custom": {"token": "secret", "keep": 3}}
        before = deepcopy(original)
        clean, omitted = sanitize_capture(original)
        self.assertEqual(original, before)
        self.assertEqual(omitted, ["password", "printhost_apikey", "token"])
        self.assertNotIn("secret", json.dumps(clean))
        self.assertEqual(clean["nodes"]["machine:Printer"]["saved"]["machine_start_gcode"], "START_PRINT\nM117 hello")
        self.assertEqual(clean["nodes"]["machine:Printer"]["source_json"]["custom"], {"keep": 3})

    def test_network_payload_limit_is_checked_before_connecting(self):
        with patch("klippee_plugin.build_opener") as opener:
            with self.assertRaisesRegex(ValueError, "too large"):
                request_json("https://klippee.xyz", "unused", "/api/orca/capture", {"large": "x" * 512_000})
            opener.assert_not_called()

    def test_transport_keeps_token_out_of_url_and_refuses_redirects(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"printerName":"QIDI"}'
        opener = MagicMock()
        opener.open.return_value = response
        with patch("klippee_plugin.build_opener", return_value=opener):
            self.assertEqual(request_json("https://klippee.xyz", "private-code", "/api/orca/capture/context", {}), {"printerName": "QIDI"})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://klippee.xyz/api/orca/capture/context")
        self.assertEqual(request.get_header("Authorization"), "Bearer private-code")
        self.assertEqual(request.get_header("User-agent"), "Klippee-OrcaSlicer/1.6.0 (+https://klippee.xyz)")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 12)
        with self.assertRaisesRegex(ValueError, "redirected"):
            NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://other.test")

    def test_bridge_captures_on_review_and_rejects_changes_before_save(self):
        fake = SimpleNamespace(pages=SimpleNamespace(PagesPluginCapabilityBase=object),
                               plugin=lambda value: value, base=object,
                               host=SimpleNamespace(preset_bundle=lambda: bundle))
        bundle = fixture()
        spec = importlib.util.spec_from_file_location("klippee_bridge_test", Path(__file__).with_name("klippee_plugin.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"orca": fake}):
            spec.loader.exec_module(module)

        class Bridge(module.KlippeeCapture):
            def post_message(self, message):
                self.message = message

            def start_request(self, *args):
                self.request = args

        bridge = Bridge()
        bridge.on_message({"command": "review", "code": "https://klippee.xyz/#klorca_" + "x" * 43})
        self.assertEqual(bridge.request[2], "/api/orca/capture/context")
        bundle.prints.edited.config["value"] = "changed after preview"
        bridge.on_message({"command": "save", "title": "Setup"})
        self.assertIn("changed after review", bridge.message["error"])
        self.assertIsNone(bridge.preview)
        self.assertEqual(bridge.request[2], "/api/orca/capture/context")

    def test_restore_bridge_rejects_invalid_files_and_stale_review_without_writes(self):
        bundle = fixture()
        fake = SimpleNamespace(pages=SimpleNamespace(PagesPluginCapabilityBase=object),
                               plugin=lambda value: value, base=object,
                               host=SimpleNamespace(preset_bundle=lambda: bundle))
        spec = importlib.util.spec_from_file_location("klippee_restore_bridge_test", Path(__file__).with_name("klippee_plugin.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"orca": fake}):
            spec.loader.exec_module(module)
        class Bridge(module.KlippeeCapture):
            def post_message(self, message):
                self.message = message
        bridge = Bridge()
        with patch.object(module, "restore_setup") as write:
            for text in ("not JSON", '{}', '{"snapshot":{}}', "x" * 600001):
                bridge.on_message({"command": "review_restore", "text": text})
                drain(bridge)
                self.assertEqual(bridge.message["command"], "error")
                self.assertIsNone(bridge.restore_preview)
            bridge.on_message({"command": "review_restore", "text": json.dumps({"snapshot": capture(bundle)})})
            drain(bridge)
            self.assertEqual(bridge.message["command"], "restore_review")
            bundle.prints.edited.config["value"] = "later user edit"
            bridge.on_message({"command": "restore"})
            self.assertIn("current setup changed", bridge.message["error"])
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
