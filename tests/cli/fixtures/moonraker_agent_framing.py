"""Verify Moonraker agent response framing and operation tracking. argv: <installer path>."""
import importlib.util
import json
import pathlib
import sys
import threading
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

class HandshakeConnection(FakeConnection):
    def __init__(self):
        super().__init__()
        remote_count = len(module.MOONRAKER_KLIPPER_REMOTE_METHODS)
        responses = [{"jsonrpc": "2.0", "id": 1, "result": {"connection_id": 7}}]
        responses.extend(
            {"jsonrpc": "2.0", "id": request_id, "result": "ok"}
            for request_id in range(2, remote_count + 2)
        )
        responses.append({
            "jsonrpc": "2.0",
            "id": remote_count + 2,
            "result": {"status": {"print_stats": {"state": "standby"}}},
        })
        self.responses = b"".join(json.dumps(response).encode() + module.ETX for response in responses)
    def recv(self, _size):
        response, self.responses = self.responses, b""
        return response

config = module.Config("https://klippee.xyz", "repo", "token", pathlib.Path("."), "printer")
agent = module.MoonrakerAgent(config, pathlib.Path("moonraker.sock"), pathlib.Path(sys.argv[1]))
handshake = HandshakeConnection()
agent.connection = handshake
assert agent.initialize_connection(handshake) == b""
assert agent.print_state == "standby"
sent_methods = [json.loads(frame[:-1])["method"] for frame in handshake.frames]
assert sent_methods == (
    ["server.connection.identify"]
    + ["connection.register_remote_method"] * len(module.MOONRAKER_KLIPPER_REMOTE_METHODS)
    + ["printer.objects.subscribe"]
)
registered_methods = [
    json.loads(frame[:-1])["params"]["method_name"]
    for frame in handshake.frames
    if json.loads(frame[:-1])["method"] == "connection.register_remote_method"
]
assert registered_methods == list(module.MOONRAKER_KLIPPER_REMOTE_METHODS)
assert module.MOONRAKER_OPERATION_STATUS_METHOD not in registered_methods
assert module.MOONRAKER_AGENT_METHODS["klippee_pull"] == ("apply", "--if-clean")
assert module.MOONRAKER_AGENT_METHODS["klippee_push"][0] == "capture"
assert module.MOONRAKER_AGENT_METHODS["klippee_status"] == ("check",)
macros = module.moonraker_macros(False)
assert "klippee_apply" in macros
assert "klippee_pull" not in macros
assert module.MOONRAKER_OPERATION_STATUS_METHOD not in macros
connection = FakeConnection()
agent.connection = connection
def fresh_printing(_config, method, params=None):
    assert method == "printer.objects.query"
    assert params == {"objects": {"print_stats": ["state"]}}
    return {"result": {"status": {"print_stats": {"state": "printing"}}}}
module.moonraker_rpc = fresh_printing
agent.print_state = "printing"
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_apply", "id": 42})
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_push", "id": 420})
messages = [json.loads(frame[:-1]) for frame in connection.frames]
assert any(message.get("id") == 42 and "error" in message for message in messages)
assert any(message.get("id") == 420 and "error" in message for message in messages)
assert any(message.get("method") == "printer.gcode.script" for message in messages)

called = []
started = threading.Event()
finish = threading.Event()
def fake_run(method, operation_id):
    called.append((method, operation_id))
    started.set()
    assert finish.wait(2)
    agent.complete_operation(operation_id, "succeeded", "configuration is current", 0)
    agent.command_lock.release()
agent.run_cli = fake_run
agent.print_state = "standby"
agent.handle_message({"jsonrpc": "2.0", "method": "klippee_check", "id": 43})
assert started.wait(2)
assert called[0][0] == "klippee_check"
messages = [json.loads(frame[:-1]) for frame in connection.frames]
accepted = next(message["result"] for message in messages if message.get("id") == 43)
assert accepted["accepted"] is True
assert accepted["operation_id"] == called[0][1]
assert agent.operation_status()["current"]["id"] == accepted["operation_id"]
agent.handle_message({
    "jsonrpc": "2.0",
    "method": module.MOONRAKER_OPERATION_STATUS_METHOD,
    "params": {"operation_id": accepted["operation_id"]},
    "id": 44,
})
messages = [json.loads(frame[:-1]) for frame in connection.frames]
running = next(message["result"] for message in messages if message.get("id") == 44)
assert running["running"] is True
assert running["found"] is True
assert running["operation_id"] == accepted["operation_id"]
assert running["current"]["status"] == "running"
assert running["last_result"] is None
agent.handle_message({
    "jsonrpc": "2.0",
    "method": module.MOONRAKER_OPERATION_STATUS_METHOD,
    "params": {"operation_id": "not-this-operation"},
    "id": 440,
})
messages = [json.loads(frame[:-1]) for frame in connection.frames]
not_found = next(message["result"] for message in messages if message.get("id") == 440)
assert not_found == {
    "running": False,
    "found": False,
    "operation_id": "not-this-operation",
    "current": None,
    "last_result": None,
}
agent.handle_message({
    "jsonrpc": "2.0",
    "method": module.MOONRAKER_OPERATION_STATUS_METHOD,
    "params": {"operation_id": ""},
    "id": 441,
})
messages = [json.loads(frame[:-1]) for frame in connection.frames]
assert "error" in next(message for message in messages if message.get("id") == 441)
finish.set()
for _ in range(100):
    if not agent.operation_status()["running"]:
        break
    time.sleep(.01)
for _ in range(100):
    if agent.command_lock.acquire(blocking=False):
        agent.command_lock.release()
        break
    time.sleep(.01)
agent.handle_message({
    "jsonrpc": "2.0",
    "method": module.MOONRAKER_OPERATION_STATUS_METHOD,
    "params": {"operation_id": accepted["operation_id"]},
    "id": 45,
})
messages = [json.loads(frame[:-1]) for frame in connection.frames]
completed = next(message["result"] for message in messages if message.get("id") == 45)
assert completed["running"] is False
assert completed["last_result"]["id"] == accepted["operation_id"]
assert completed["last_result"]["status"] == "succeeded"
assert completed["last_result"]["return_code"] == 0

agent.handle_message({"jsonrpc": "2.0", "method": "klippee_status", "id": 46})
for _ in range(100):
    if len(called) == 2:
        break
    time.sleep(.01)
messages = [json.loads(frame[:-1]) for frame in connection.frames]
legacy_accepted = next(message["result"] for message in messages if message.get("id") == 46)
assert legacy_accepted["command"] == "check"
assert legacy_accepted["operation_id"] != accepted["operation_id"]
for _ in range(100):
    if not agent.operation_status()["running"] and agent.command_lock.acquire(blocking=False):
        agent.command_lock.release()
        break
    time.sleep(.01)

original_thread_start = module.threading.Thread.start
def fail_thread_start(_thread):
    raise RuntimeError("thread capacity exhausted")
module.threading.Thread.start = fail_thread_start
try:
    agent.handle_message({"jsonrpc": "2.0", "method": "klippee_check", "id": 47})
finally:
    module.threading.Thread.start = original_thread_start
messages = [json.loads(frame[:-1]) for frame in connection.frames]
start_failure = [message for message in messages if message.get("id") == 47]
assert len(start_failure) == 1
assert "error" in start_failure[0]
assert "accepted" not in start_failure[0].get("result", {})
failed_status = agent.operation_status()
assert failed_status["running"] is False
assert failed_status["current"] is None
assert failed_status["last_result"]["status"] == "failed"
assert "thread capacity exhausted" in failed_status["last_result"]["summary"]
assert agent.command_lock.acquire(blocking=False)
agent.command_lock.release()
try:
    agent.handle_message({
        "jsonrpc": "2.0",
        "id": min(agent.setup_request_ids),
        "error": {"message": "duplicate agent"},
    })
except OSError as error:
    assert "duplicate agent" in str(error)
else:
    raise AssertionError("agent setup errors must force a reconnect")
