"""Regression checks for Orca audit, page recovery and unload boundaries."""
import importlib.util
from pathlib import Path
import sys
import time
from tempfile import TemporaryDirectory
from threading import Event
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_preset_spike import fixture


def bridge_module():
    bundle = fixture()
    fake = SimpleNamespace(pages=SimpleNamespace(PagesPluginCapabilityBase=object),
                           plugin=lambda cls: cls, base=object,
                           host=SimpleNamespace(preset_bundle=lambda: bundle))
    spec = importlib.util.spec_from_file_location("lifecycle_bridge_test", Path(__file__).with_name("klippee_plugin.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"orca": fake}):
        spec.loader.exec_module(module)
    class Bridge(module.KlippeeCapture):
        def post_message(self, message):
            self.message = message
    return module, Bridge(), bundle


class LifecycleTests(unittest.TestCase):
    def test_denied_native_network_audit_prevents_worker_and_request(self):
        module, page, _ = bridge_module()
        with patch("sys.audit", side_effect=PermissionError("denied")) as audit, patch.object(module, "Thread") as worker:
            page.on_message({"command": "review", "code": "https://klippee.xyz/#klorca_" + "x" * 43})
            worker.assert_not_called()
            audit.assert_called_once()
            self.assertEqual(audit.call_args.args[0], "urllib.Request")
            self.assertEqual(page.message["command"], "error")
            self.assertIn("denied", page.message["error"].lower())
            self.assertFalse(page.busy)

    def test_ready_recovers_authoritative_view_busy_state_and_title_without_code(self):
        module, page, _ = bridge_module()
        page.publish({"command": "connected", "data": {"printerName": "example1"}, "selections": [], "nodes": 9, "omittedKeys": [], "origin": "https://klippee.xyz"})
        page.on_message({"command": "set_title", "title": "My QIDI setup"})
        with TemporaryDirectory() as folder:
            module.orca.host.plugin = SimpleNamespace(storage=lambda: folder)
            page.on_message({"command": "ready"})
        self.assertEqual(page.message["command"], "state")
        self.assertEqual(page.message["view"]["command"], "connected")
        self.assertEqual(page.message["title"], "My QIDI setup")
        self.assertNotIn("code", page.message)

    def test_unload_disables_further_native_access(self):
        module, page, _ = bridge_module()
        page.on_unload()
        with patch.object(module.orca.host, "preset_bundle") as native:
            page.on_message({"command": "review", "code": "https://klippee.xyz/#klorca_" + "x" * 43})
            native.assert_not_called()
        self.assertIsNone(page.connection)
        self.assertIsNone(page.preview)

    def test_unload_cancels_worker_and_discards_late_results_after_reload(self):
        _, page, _ = bridge_module()
        entered, release = Event(), Event()
        def work():
            entered.set()
            release.wait(2)
            return {"printerName": "stale"}
        page.start_work(work, "connected")
        worker, old_job = page.worker, page.stop_work
        self.assertTrue(entered.wait(1))
        page.on_unload()
        release.set()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(old_job.is_set())
        page.on_load()
        page.results.put({"command": "connected", "data": {}, "_job": old_job})
        page.on_message({"command": "poll"})
        self.assertTrue(page.results.empty())
        self.assertIsNone(page.view)

    def test_cancelling_a_request_shuts_down_socket_without_joining_reader(self):
        module, _, _ = bridge_module()
        from unittest.mock import MagicMock
        connection = MagicMock()
        lease = module.RequestLease()
        lease.connection = connection
        lease.cancel()
        connection.shutdown.assert_called_once_with(module.socket.SHUT_RDWR)
        connection.close.assert_called_once()
        with self.assertRaises(ValueError):
            lease.check()

    def test_unload_does_not_wait_on_an_actual_blocked_http_read(self):
        module, _, _ = bridge_module()
        entered, release = Event(), Event()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b'{')
                self.wfile.flush()
                entered.set()
                release.wait(3)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        serving = Thread(target=server.serve_forever, daemon=True)
        serving.start()
        lease = module.RequestLease()
        errors = []
        def request():
            try:
                module.send_request(module.make_request("http://127.0.0.1:" + str(server.server_port), "test", "/", {}), lease)
            except Exception as error:
                errors.append(type(error).__name__)
        worker = Thread(target=request, daemon=True)
        try:
            worker.start()
            self.assertTrue(entered.wait(2))
            started = time.monotonic()
            lease.cancel()
            self.assertLess(time.monotonic() - started, 0.25, "Cancellation waited on the buffered reader")
            # Windows may keep the read blocked until peer close or the socket
            # timeout, even after shutdown on a duplicate descriptor. Never join
            # it in on_unload; stop flags discard its eventual result instead.
            release.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertTrue(errors)
        finally:
            release.set()
            lease.cancel()
            worker.join(2)
            server.shutdown()
            server.server_close()
            serving.join(2)


if __name__ == "__main__":
    unittest.main()
