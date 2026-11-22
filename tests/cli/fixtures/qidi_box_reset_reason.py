"""Query the QIDI Box reset reason through a mocked, non-resetting transport.

argv: <installer path>.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

# The production installer at ~/.local/bin/klippee is extensionless.
# Exercise the exact isolated child bootstrap against an extensionless source
# so Python never falls back to suffix-based import loader discovery.
with tempfile.TemporaryDirectory() as temporary_directory:
    extensionless = pathlib.Path(temporary_directory) / "transport_fixture"
    extensionless.write_text(
        "def _query_qidi_box_reset_reason_transport(serial, klippy_dir):\n"
        "    return {'serial': serial, 'klippy_dir': klippy_dir}\n",
        encoding="utf-8",
    )
    bootstrap_result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            module.QIDI_BOX_TRANSPORT_BOOTSTRAP,
            str(extensionless),
            "box-serial",
            "klippy-dir",
        ],
        capture_output=True,
        check=False,
        text=True,
    )
assert bootstrap_result.returncode == 0, bootstrap_result.stderr
assert json.loads(bootstrap_result.stdout) == {
    "serial": "box-serial",
    "klippy_dir": "klippy-dir",
}

config = module.Config("https://klippee.xyz", "repo", "token", pathlib.Path("."), "printer")
configured = "/dev/serial/by-id/usb-Klipper_QIDI_BOX_V1_1.1.1_4B006E000F51353033353536-if00"
shutdown_snapshot = {
    "result": {
        "status": {
            "webhooks": {"state": "shutdown", "state_message": "Lost communication"},
            "configfile": {
                "settings": {
                    "mcu mcu_box1": {"serial": configured, "restart_method": "command"}
                }
            },
        }
    }
}
module.moonraker_rpc = lambda *_args, **_kwargs: shutdown_snapshot
assert module.fresh_qidi_box_query_config(config) == configured
module.moonraker_rpc = lambda *_args, **_kwargs: {
    "result": {"status": {"webhooks": {"state": "ready"}, "configfile": {"settings": {}}}}
}
try:
    module.fresh_qidi_box_query_config(config)
except module.CliError as error:
    assert "shutdown" in str(error)
else:
    raise AssertionError("non-shutdown state was accepted")

identity = {
    "vendor_id": "1d50",
    "product_id": "614e",
    "manufacturer": "Klipper",
    "product": "QIDI_BOX_V1_1.1.1",
    "serial": "4B006E000F51353033353536",
}
assert module.validate_qidi_box_usb_identity(pathlib.Path(configured).name, identity) == identity["serial"]
bad_identity = dict(identity)
bad_identity["product_id"] = "0001"
try:
    module.validate_qidi_box_usb_identity(pathlib.Path(configured).name, bad_identity)
except module.CliError as error:
    assert "product_id" in str(error)
else:
    raise AssertionError("wrong USB identity was accepted")

raw_dictionary = json.dumps({"test": "canonical"}, separators=(",", ":"), sort_keys=True).encode()
dictionary_hash = hashlib.sha256(raw_dictionary).hexdigest()

class FakeParser:
    def get_version_info(self):
        return module.QIDI_BOX_FIRMWARE_VERSION, "test-build"
    def get_constants(self):
        return {"MCU": module.QIDI_BOX_FIRMWARE_MCU}
    def get_raw_data_dictionary(self):
        return raw_dictionary
    def get_messages(self):
        return [
            (89, "command", module.QIDI_BOX_QUERY_COMMAND),
            (-2, "response", module.QIDI_BOX_QUERY_RESPONSE),
            (12, "command", module.QIDI_BOX_DEBUG_READ_COMMAND),
            (-30, "response", module.QIDI_BOX_DEBUG_RESULT_RESPONSE),
        ]
    def create_command(self, command):
        if command == "debug_read order=2 addr=0x40023874":
            return b"encoded-csr-query"
        if command == "reset_reason_get oid=165":
            return b"encoded-reason-query"
        raise AssertionError(command)

class FakeCompletion:
    def __init__(self):
        self.value = None
    def complete(self, value):
        self.value = value
    def wait(self, _deadline):
        return self.value

class FakeReactor:
    def __init__(self):
        self.last_completion = None
        self.async_completions = []
    def completion(self):
        self.last_completion = FakeCompletion()
        return self.last_completion
    def async_complete(self, completion, value):
        self.async_completions.append((completion, value))
        completion.complete(value)
    def monotonic(self):
        return 10.0

class FakeReader:
    def __init__(self, response_oid=165, rcc_csr=0x22000003):
        self.parser = FakeParser()
        self.handlers = {}
        self.response_oid = response_oid
        self.rcc_csr = rcc_csr
        self.sent = []
    def get_msgparser(self):
        return self.parser
    def register_response(self, callback, name, oid=None):
        assert (name, oid) in {("debug_result", None), ("reset_reason_return", 165)}
        key = (name, oid)
        if callback is None:
            self.handlers.pop(key, None)
        else:
            self.handlers[key] = callback
    def get_default_command_queue(self):
        return "queue"
    def raw_send_wait_ack(self, command, minclock, reqclock, queue):
        assert minclock == 0 and reqclock == 0 and queue == "queue"
        self.sent.append(command)
        if command == b"encoded-csr-query":
            self.handlers[("debug_result", None)]({"val": self.rcc_csr})
        elif command == b"encoded-reason-query":
            self.handlers[("reset_reason_return", 165)]({
                "oid": self.response_oid,
                "reason": b"IndependentWatchdog",
            })
        else:
            raise AssertionError(command)

reader = FakeReader()
reactor = FakeReactor()
session = module.query_qidi_box_reset_reason_session(reader, reactor, dictionary_hash)
assert session["reason"] == "IndependentWatchdog"
assert session["rcc_csr"] == 0x22000003
assert reader.sent == [b"encoded-csr-query", b"encoded-reason-query"]
assert len(reactor.async_completions) == 2
try:
    module.query_qidi_box_reset_reason_session(FakeReader(0), FakeReactor(), dictionary_hash)
except module.CliError as error:
    assert "matching" in str(error)
else:
    raise AssertionError("a response with the wrong correlation OID was accepted")

endpoint = {
    "configured": configured,
    "resolved": "/dev/ttyACM3",
    **identity,
}
transport = {
    "version": module.QIDI_BOX_FIRMWARE_VERSION,
    "mcu": module.QIDI_BOX_FIRMWARE_MCU,
    "dictionary_sha256": module.QIDI_BOX_DICTIONARY_SHA256,
    "reason": "IndependentWatchdog",
    "rcc_csr": 0x22000003,
    "endpoint": endpoint,
    "preconditions": {"endpoint_unowned": True, "exclusive_open": True},
}
public_result = module.validate_qidi_box_public_result(
    module.build_qidi_box_reset_reason_result(transport, endpoint)
)
assert public_result["query"]["reset_reason"]["oid"] == 165
assert public_result["query"]["rcc_csr"] == {
    "command": module.QIDI_BOX_DEBUG_READ_COMMAND,
    "response": module.QIDI_BOX_DEBUG_RESULT_RESPONSE,
    "address": "0x40023874",
    "order": 2,
}
assert public_result["reset_flags"] == {
    "register": "RCC_CSR",
    "address": "0x40023874",
    "raw": 0x22000003,
    "raw_hex": "0x22000003",
    "asserted": ["IndependentWatchdog", "Brownout"],
}
assert public_result["preconditions"] == {
    "fresh_klippy_state": "shutdown",
    "endpoint_unowned": True,
    "exclusive_open": True,
}
assert public_result["safety"] == {
    "read_only": True,
    "reset_requested": False,
    "flags_cleared": False,
    "config_changed": False,
    "klipper_action": "none",
    "may_be_stale": True,
}

@contextlib.contextmanager
def fake_lock():
    yield

module.load_config = lambda: config
module.qidi_box_query_lock = fake_lock
snapshots = iter([configured, configured])
module.fresh_qidi_box_query_config = lambda _config: next(snapshots)
module.resolve_qidi_box_endpoint = lambda _serial: endpoint
unowned_checks = []
module.require_unowned_qidi_box_tty = lambda value: unowned_checks.append(value)
module.run_qidi_box_reset_reason_transport = lambda _serial: transport
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    assert module.cmd_query_box_reset_reason([]) == 0
output_lines = stdout.getvalue().splitlines()
assert len(output_lines) == 1
assert json.loads(output_lines[0]) == public_result
assert unowned_checks == [endpoint]

agent = module.MoonrakerAgent(config, pathlib.Path("moonraker.sock"), pathlib.Path(sys.argv[1]))
operation = agent.begin_operation("klippee_query_box_reset_reason")
assert agent.command_lock.acquire(blocking=False)
original_run = module.subprocess.run
module.subprocess.run = lambda *_args, **_kwargs: subprocess.CompletedProcess(
    args=[], returncode=0, stdout=json.dumps(public_result, separators=(",", ":")) + "\n", stderr=""
)
try:
    agent.run_cli("klippee_query_box_reset_reason", operation["id"])
finally:
    module.subprocess.run = original_run
status = agent.operation_status(operation["id"])
assert status["running"] is False
assert status["last_result"]["status"] == "succeeded"
assert status["last_result"]["result"] == public_result
assert module.MOONRAKER_AGENT_METHODS["klippee_query_box_reset_reason"] == ("query-box-reset-reason",)
assert "klippee_query_box_reset_reason" not in module.moonraker_macros(False)
