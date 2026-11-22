"""Verify the Moonraker Unix socket fallback when localhost HTTP is unavailable.

argv: <installer path>.
"""
import importlib.util
import json
import pathlib
import sys

spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class FakePath:
    def is_socket(self):
        return True
    def __str__(self):
        return "/tmp/moonraker.sock"

class FakeSocket:
    def __init__(self):
        self.response = b""
    def settimeout(self, _timeout):
        pass
    def connect(self, path):
        assert path == "/tmp/moonraker.sock"
    def sendall(self, payload):
        request = json.loads(payload[:-1])
        assert request["method"] == "printer.info"
        notification = json.dumps({
            "jsonrpc": "2.0",
            "method": "notify_status_update",
            "params": [{"print_stats": {"state": "printing"}}],
        }).encode() + module.ETX
        unrelated = json.dumps({
            "jsonrpc": "2.0",
            "id": 999,
            "result": {"state": "not-the-requested-response"},
        }).encode() + module.ETX
        matching = json.dumps({
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {"state": "ready", "software_version": "v0.13.0-socket"},
        }).encode() + module.ETX
        self.response = notification + unrelated + matching
    def recv(self, _size):
        response, self.response = self.response, b""
        return response
    def close(self):
        pass

module.moonraker_json = lambda _path: {}
module.moonraker_socket_path = lambda _config: FakePath()
module.socket.AF_UNIX = 1
module.socket.socket = lambda *_args, **_kwargs: FakeSocket()
config = module.Config("https://klippee.xyz", "repo", "token", pathlib.Path("."), "printer")
response = module.diagnostic_moonraker_request(config, "/printer/info", "printer.info")
assert response["result"]["state"] == "ready"
assert response["result"]["software_version"] == "v0.13.0-socket"

class DeadlineSocket(FakeSocket):
    def __init__(self):
        super().__init__()
        self.timeouts = []
    def settimeout(self, timeout):
        self.timeouts.append(timeout)
    def sendall(self, _payload):
        self.response = json.dumps({
            "jsonrpc": "2.0", "id": 999, "result": "unrelated"
        }).encode() + module.ETX
    def recv(self, _size):
        response, self.response = self.response, b""
        if response:
            return response
        # A peer that produces no matching response must fail closed.
        raise module.socket.timeout()

deadline_socket = DeadlineSocket()
module.socket.socket = lambda *_args, **_kwargs: deadline_socket
assert module.moonraker_rpc(config, "printer.info") == {}
assert deadline_socket.timeouts and deadline_socket.timeouts[0] <= 2.0
