"""Test-only lifecycle driver for the real downloadable restore page bridge."""

class NativeRestoreProbe(orca.script.ScriptPluginCapabilityBase):
    ran = False

    def get_name(self):
        return "Klippee disposable restore verification"

    def on_lifecycle_event(self, event, context):
        if self.ran or event not in (orca.LifecycleEvent.ProjectOpened, orca.LifecycleEvent.ObjectAdded):
            return
        storage = Path(orca.host.plugin.storage())
        root = next((p.parent for p in storage.parents if p.name == "orca_plugins"), None)
        if root is None or not (root / "klippee-restore-probe.json").is_file():
            return
        self.ran = True
        result = {"passed": False, "host": orca.host.app_info()}
        try:
            original_restore = globals()["restore_setup"]
            def diagnostic_restore(*args, **kwargs):
                try:
                    return original_restore(*args, **kwargs)
                except Exception as error:
                    storage.joinpath("restore-diagnostic.json").write_text(json.dumps({"error": str(error.__cause__)}), encoding="utf-8")
                    raise
            globals()["restore_setup"] = diagnostic_restore
            class Probe(KlippeeCapture):
                def post_message(self, message):
                    self.message = message

            options = json.loads((root / "klippee-restore-probe.json").read_text(encoding="utf-8"))
            page = Probe()
            import time
            ticks = []
            def drive():
                deadline = time.monotonic() + 30
                while page.busy and time.monotonic() < deadline:
                    started = time.monotonic()
                    page.on_message({"command": "poll"})
                    ticks.append((time.monotonic() - started) * 1000)
                    time.sleep(0.001)
                assert not page.busy, "Native queued operation did not finish"
            bundle = orca.host.preset_bundle()
            before = capture(bundle)
            try:
                sys.audit("open", str(root / "OrcaSlicer.conf"), "r", 0)
            except PermissionError:
                result["native_audit_denial_verified"] = True
            else:
                raise AssertionError("Native audit did not reject the protected app configuration")
            if options["mode"] == "restore":
                page.on_message({"command": "review_restore", "text": (root / "saved-setup.json").read_text(encoding="utf-8")})
                drive()
                assert page.message["command"] == "restore_review", page.message
                source = deepcopy(page.restore_preview)
                page.on_message({"command": "restore"})
                drive()
                assert page.message["command"] == "restored", page.message
                assert capture(bundle) == before, "Current selections or edit buffers changed"
                result.update(names=page.restore_result["names"], source_selections=selection_summary(source),
                              captured_nodes=len(source["nodes"]), restored_nodes=page.restore_result["nodes"],
                              settings_compared=sum(len(comparison_keys(v, v)) for v in page.restore_result["expected"].values()),
                              ancestor_settings_compared=sum(len(comparison_keys(v, v)) for v in page.restore_result["ancestors"].values()),
                              live_state_preserved=True)
                # A separate restore proves dirty buffers and repeated filament slots,
                # while the receipt above remains the exported QIDI setup under test.
                edited, _ = sanitize_capture(before)
                edited["selections"][1]["effective"]["layer_height"] = "0.21"
                edited["selections"][1]["dirty"] = True
                duplicate = deepcopy(edited["selections"][2])
                duplicate["slot"] = len(edited["selections"]) - 2
                duplicate["effective"]["nozzle_temperature"] = "219"
                duplicate["dirty"] = True
                edited["selections"].append(duplicate)
                edited = validate_restore({"snapshot": edited})
                extra = restore_setup(edited, bundle, storage, orca.host.preset.bundles.reload_local)
                result.update(dirty_and_repeated_slot_verified=True, additional_slots=len(extra["names"]) - 2)
                page.on_message({"command": "ready"})
                assert page.message["command"] == "state" and not page.message["busy"]
                assert page.message["view"]["names"] == page.restore_result["names"]
                result["page_state_recovery_verified"] = True
            else:
                page.read_restore_receipt()
                restored = page.restore_result
                failures = verify(bundle, restored["expected"]) + verify(bundle, restored["ancestors"]) + verify_graph(bundle, restored["graph"])
                assert not failures, [{k: v for k, v in f.items() if k in {"preset", "key", "error"}} for f in failures]
                result.update(restored_nodes=restored["nodes"], names=restored["names"])
                if options["mode"] == "selected":
                    page.on_message({"command": "check_restore"})
                    drive()
                    assert page.message["command"] == "restore_verified", page.message
                    compatibility = [bool(getattr(bundle, COLLECTIONS[item["kind"]]).find_preset(name).is_compatible)
                                     for item, name in zip(selection_summary(before), restored["names"])]
                    assert all(compatibility), "Selected preset incompatible"
                    result.update(filament_slots=page.message["slots"], selected_settings_verified=True,
                                  compatible=compatibility)
            result["passed"] = True
            result["poll_steps"] = len(ticks)
            result["max_poll_ms"] = round(max(ticks, default=0), 2)
            page.on_unload()
            assert not page.loaded and page.steps is None and page.connection is None
            result["unload_cleanup_verified"] = True
        except Exception as error:
            result = {"passed": False, "error": str(error)}
            diagnostic = storage / "restore-diagnostic.json"
            if diagnostic.is_file():
                result["diagnostic"] = json.loads(diagnostic.read_text(encoding="utf-8"))
        storage.joinpath("restore-probe-result.json").write_text(json.dumps(result), encoding="utf-8")
