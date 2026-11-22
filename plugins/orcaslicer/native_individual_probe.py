"""Disposable native verification of exported individual profiles and restart."""

class NativeRestoreProbe(orca.script.ScriptPluginCapabilityBase):
    ran = False

    def get_name(self):
        return "Klippee individual profile verification"

    def on_lifecycle_event(self, event, context):
        if self.ran or event not in (orca.LifecycleEvent.ProjectOpened, orca.LifecycleEvent.ObjectAdded):
            return
        self.ran = True
        storage = Path(orca.host.plugin.storage())
        root = next(p.parent for p in storage.parents if p.name == "orca_plugins")
        result = {"passed": False}
        try:
            import time
            class Probe(KlippeeCapture):
                def post_message(self, message):
                    self.message = message
            page = Probe()
            def drive():
                deadline = time.monotonic() + 60
                while page.busy and time.monotonic() < deadline:
                    page.on_message({"command": "poll"})
                    time.sleep(0.001)
                assert not page.busy, "Restore timed out"
            before = capture(orca.host.preset_bundle())
            mode = json.loads((root / "klippee-restore-probe.json").read_text())["mode"]
            plans_file = storage / "individual-plans.json"
            if mode == "restore":
                plans = []
                documents = json.loads((root / "saved-setup.json").read_text(encoding="utf-8"))["profiles"]
                for document in documents:
                    page.on_message({"command": "review_restore", "text": json.dumps(document)})
                    drive()
                    assert page.message["command"] == "restore_review", page.message
                    page.on_message({"command": "restore"})
                    drive()
                    assert page.message["command"] == "restored", page.message
                    assert page.message["profile"], page.message
                    plans.append(page.restore_result)
                    assert capture(orca.host.preset_bundle()) == before, "Active setup changed"
                plans_file.write_text(json.dumps(plans), encoding="utf-8")
            else:
                plans = json.loads(plans_file.read_text(encoding="utf-8"))
            for plan in plans:
                failures = verify(orca.host.preset_bundle(), plan["expected"]) + verify(orca.host.preset_bundle(), plan["ancestors"]) + verify_graph(orca.host.preset_bundle(), plan["graph"])
                assert not failures, [{k: v for k, v in f.items() if k in {"preset", "key", "error"}} for f in failures]
            page.read_restore_receipt()
            page.on_message({"command": "check_restore"})
            drive()
            assert page.message["command"] == "profile_verified", page.message
            assert capture(orca.host.preset_bundle()) == before, "Verification changed active setup"
            result.update(passed=True, profiles=len(plans), restored_nodes=sum(p["nodes"] for p in plans),
                          settings_compared=sum(len(comparison_keys(v, v)) for p in plans for v in [*p["expected"].values(), *p["ancestors"].values()]),
                          live_state_preserved=True, receipt_verified=True)
            page.on_unload()
        except Exception as error:
            result.update(error=str(error))
        (storage / "restore-probe-result.json").write_text(json.dumps(result), encoding="utf-8")
