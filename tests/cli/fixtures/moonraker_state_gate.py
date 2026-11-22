"""Assert every mutating Moonraker RPC is gated on a fresh fail-closed printer-state query.

argv: <installer path>.
"""
import importlib.util
import json
import pathlib
import sys
import time

spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class FakeConnection:
    def __init__(self):
        self.frames = []
    def sendall(self, payload):
        self.frames.append(payload)

config = module.Config("https://klippee.xyz", "repo", "token", pathlib.Path("."), "printer")
agent = module.MoonrakerAgent(config, pathlib.Path("moonraker.sock"), pathlib.Path(sys.argv[1]))
connection = FakeConnection()
agent.connection = connection

fresh_results = [
    {"result": {"status": {"print_stats": {"state": "standby"}}}},
    {"result": {"status": {"print_stats": {"state": "complete"}}}},
    {"result": {"status": {"print_stats": {"state": "printing"}}}},
    {"result": {"status": {"print_stats": {"state": "paused"}}}},
    {},
    {"result": {"status": {"print_stats": {"state": "future-state"}}}},
]
queries = []
def fake_moonraker_rpc(received_config, method, params=None):
    queries.append((received_config, method, params))
    return fresh_results.pop(0)
module.moonraker_rpc = fake_moonraker_rpc

called = []
def fake_run(method, operation_id):
    called.append(method)
    agent.complete_operation(operation_id, "succeeded", "done", 0)
    agent.command_lock.release()
agent.run_cli = fake_run

def wait_until_idle():
    for _ in range(100):
        if not agent.operation_status()["running"] and agent.command_lock.acquire(blocking=False):
            agent.command_lock.release()
            return
        time.sleep(.01)
    raise AssertionError("agent did not become idle")

# Cached paused state must not block a fresh, authoritative standby result.
agent.print_state = "paused"
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_apply", "id": 101})
wait_until_idle()

# The legacy capture alias has the identical fresh-state gate.
agent.print_state = "printing"
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_push", "id": 102})
wait_until_idle()

# A stale-safe cache cannot override fresh active states for canonical or legacy calls.
agent.print_state = "standby"
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_capture", "id": 103})
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_pull", "id": 104})

# Query failure and a state unknown to this client both fail closed.
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_apply", "id": 105})
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_push", "id": 106})

messages = [json.loads(frame[:-1]) for frame in connection.frames]
accepted_apply = next(message["result"] for message in messages if message.get("id") == 101)
accepted_push = next(message["result"] for message in messages if message.get("id") == 102)
assert accepted_apply["accepted"] is True
assert accepted_apply["command"] == "apply"
assert accepted_push["accepted"] is True
assert accepted_push["command"] == "capture"
assert called == ["klippee_apply", "klippee_push"]

for request_id, expected_state in ((103, "printing"), (104, "paused"), (105, "unknown"), (106, "unknown")):
    response = next(message for message in messages if message.get("id") == request_id)
    assert "error" in response
    assert expected_state in response["error"]["message"]

assert len(queries) == 6
for received_config, method, params in queries:
    assert received_config is config
    assert method == "printer.objects.query"
    assert params == {"objects": {"print_stats": ["state"]}}
assert fresh_results == []
