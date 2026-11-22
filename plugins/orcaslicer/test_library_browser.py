"""Direct library browsing, read-only requests and the native restore review boundary."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import time
import unittest
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from capture_core import capture
from test_plugin_lifecycle import bridge_module


class LibraryBrowserTests(unittest.TestCase):
    def listing(self):
        return {"library": {"id": "import-1", "profiles": [{"id": "machine:Printer", "name": "Printer", "kind": "machine", "nozzle": "0.2", "parent": "Base Printer", "custom": True}]},
                "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}

    def drive(self, page):
        deadline = time.monotonic() + 3
        while page.busy and time.monotonic() < deadline:
            page.on_message({"command": "poll"})
            time.sleep(0.001)
        self.assertFalse(page.busy)

    def test_browse_and_download_use_separate_read_only_routes_and_validate_the_chosen_profile(self):
        module, page, bundle = bridge_module()
        snapshot = capture(bundle)
        nodes = {}; at = "machine:Printer"
        while at:
            nodes[at] = deepcopy(snapshot["nodes"][at]); at = nodes[at]["parent"]
        document = {"snapshot": {"format": "klippee-orca-profile/v1", "nodes": nodes, "selections": [{"node": "machine:Printer", "slot": None, "dirty": False, "effective": deepcopy(nodes["machine:Printer"]["saved"]), "changes": {}}]}}
        token = "klorca_" + "x" * 43
        with TemporaryDirectory() as folder, patch.object(module.orca.host, "plugin", SimpleNamespace(storage=lambda: folder), create=True), patch.object(module, "send_request", side_effect=[{"connected": True}, self.listing(), document]) as transport, patch("sys.audit"):
            page.on_message({"command": "browse_library", "code": "https://klippee.xyz/#" + token})
            self.drive(page)
            self.assertEqual(page.message["command"], "library_listed")
            self.assertNotIn(token, json.dumps(page.message))
            page.on_message({"command": "review_library_profile", "profileId": "machine:Printer"})
            self.drive(page)
        self.assertEqual(page.message["command"], "restore_review")
        self.assertTrue(page.message["profile"])
        self.assertEqual(page.restore_preview["nodes"], nodes)
        self.assertEqual(capture(bundle), snapshot)
        requests = [call.args[0] for call in transport.call_args_list]
        self.assertEqual([r.full_url for r in requests], ["https://klippee.xyz/api/orca/restore/pair", "https://klippee.xyz/api/orca/restore/library", "https://klippee.xyz/api/orca/restore/profile"])
        self.assertEqual(json.loads(requests[2].data), {"profileId": "machine:Printer", "importId": "import-1"})
        page.on_unload()
        self.assertIsNone(page.browse_connection)
        self.assertIsNone(page.browse_library)
        with self.assertRaises(ValueError):
            module.validate_library_profile(document, "machine:Different")

    def test_expired_unknown_and_denied_browse_requests_never_download_profiles(self):
        module, page, _ = bridge_module()
        page.browse_connection = ("https://klippee.xyz", "klorca_" + "x" * 43)
        page.browse_library = module.validate_library_listing(self.listing())
        with patch.object(page, "start_request") as request:
            page.on_message({"command": "review_library_profile", "profileId": "machine:unknown"})
            request.assert_not_called()
            page.browse_library["expiresAt"] = "2000-01-01T00:00:00Z"
            page.on_message({"command": "review_library_profile", "profileId": "machine:Printer"})
            request.assert_not_called()
        self.assertIsNone(page.browse_connection)
        with TemporaryDirectory() as folder, patch.object(module.orca.host, "plugin", SimpleNamespace(storage=lambda: folder), create=True), patch("sys.audit", side_effect=PermissionError("denied")), patch.object(module, "Thread") as worker:
            page.on_message({"command": "browse_library", "code": "https://klippee.xyz/#klorca_" + "x" * 43})
            worker.assert_not_called()
        self.assertEqual(page.message["command"], "error")

    def test_connection_survives_a_new_plugin_instance_without_exposing_the_secret(self):
        module, page, _ = bridge_module()
        token = "klorcadevice_" + "s" * 43
        listing = self.listing(); listing["expiresAt"] = None
        with TemporaryDirectory() as folder, patch.object(module.orca.host, "plugin", SimpleNamespace(storage=lambda: folder), create=True), patch("sys.audit"):
            module.store_connection("https://klippee.xyz", token)
            page.on_unload()
            resumed = type(page)()
            with patch.object(module, "send_request", return_value=listing) as transport:
                resumed.on_message({"command": "ready"})
                self.drive(resumed)
            self.assertEqual(resumed.message["command"], "library_listed")
            self.assertEqual(transport.call_args.args[0].get_header("Authorization"), "Bearer " + token)
            resumed.on_message({"command": "ready"})
            self.assertNotIn(token, json.dumps(resumed.message))
            self.assertTrue(Path(folder, "library-connection.json").exists())
            with patch.object(module, "send_request", return_value={"ok": True}) as transport:
                resumed.on_message({"command": "disconnect_library"})
                self.drive(resumed)
            self.assertTrue(transport.call_args.args[0].full_url.endswith("/restore/disconnect"))
            self.assertFalse(Path(folder, "library-connection.json").exists())
            self.assertIsNone(resumed.browse_connection)

    def test_revocation_forgets_saved_credentials_but_network_errors_keep_them(self):
        module, page, _ = bridge_module()
        with TemporaryDirectory() as folder, patch.object(module.orca.host, "plugin", SimpleNamespace(storage=lambda: folder), create=True), patch("sys.audit"):
            module.store_connection("https://klippee.xyz", "klorcadevice_" + "s" * 43)
            with patch.object(module, "send_request", side_effect=ValueError("Offline")):
                page.on_message({"command": "ready"}); self.drive(page)
            self.assertIsNotNone(module.load_connection())
            with patch.object(module, "send_request", side_effect=module.DisconnectedError("Disconnected")):
                page.on_message({"command": "reload_library"}); self.drive(page)
            self.assertIsNone(module.load_connection())
            self.assertTrue(page.message["disconnected"])

    def test_listing_rejects_expired_duplicate_and_malformed_profiles(self):
        module, _, _ = bridge_module()
        for mutation in [lambda d: d.update(expiresAt="2000-01-01T00:00:00Z"),
                         lambda d: d["library"]["profiles"].append(deepcopy(d["library"]["profiles"][0])),
                         lambda d: d["library"]["profiles"][0].update(id="filament:Printer")]:
            data = self.listing(); mutation(data)
            with self.assertRaises(ValueError):
                module.validate_library_listing(data)


if __name__ == "__main__":
    unittest.main()
