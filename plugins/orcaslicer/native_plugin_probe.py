"""Appended only to the disposable test installation, never the download."""

class NativeCaptureProbe(orca.script.ScriptPluginCapabilityBase):
    ran = False

    def get_name(self):
        return "Klippee disposable capture verification"

    def on_lifecycle_event(self, event, context):
        if self.ran or event != orca.LifecycleEvent.ProjectOpened:
            return
        storage = Path(orca.host.plugin.storage())
        root = next((parent.parent for parent in storage.parents if parent.name == "orca_plugins"), None)
        if root is None or not (root / "klippee-spike-profile.json").is_file():
            return
        self.ran = True
        result = {"passed": False}
        try:
            class Probe(KlippeeCapture):
                messages = []
                requests = []

                def post_message(self, message):
                    self.messages.append(message)

                def start_request(self, origin, token, path, payload, command):
                    # Exercise the actual page bridge with deterministic server replies.
                    # Network/API behavior is covered independently by HTTP and Worker tests.
                    self.requests.append((path, payload))
                    self.results.put({"command": command, "data": {"printerName": "Disposable QIDI test"}})

            page = Probe()
            assert "Review setup" in page.get_ui()
            page.on_message({"command": "review", "code": "http://127.0.0.1/#klorca_" + "x" * 43})
            page.on_message({"command": "poll"})
            review = page.messages[-1]
            assert review["command"] == "connected"
            page.on_message({"command": "save", "title": "Native QIDI capture"})
            payload = page.requests[-1][1]
            assert page.requests[-1][0] == "/api/orca/capture"
            payload_bytes = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            assert payload_bytes <= MAX_BYTES
            page.on_message({"command": "poll"})
            snapshot = payload["snapshot"]
            result = {"passed": page.messages[-1]["command"] == "saved" and page.preview is None and page.connection is None,
                      "host_version": payload["hostVersion"], "selections": len(snapshot["selections"]),
                      "filament_slots": len(snapshot["selections"]) - 2,
                      "dirty_selections": sum(item["dirty"] for item in snapshot["selections"]),
                      "payload_bytes": payload_bytes,
                      "ancestry_nodes": len(snapshot["nodes"]), "omitted_keys": payload["omittedKeys"],
                      "native_page_bridge_verified": True, "transport": "test double; no network or printer actions"}
        except Exception:
            result = {"passed": False, "error": "Native plugin page bridge verification failed"}
        storage.joinpath("native-plugin-result.json").write_text(json.dumps(result), encoding="utf-8")
