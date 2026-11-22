# /// script
# requires-python = ">=3.12"
# [tool.orcaslicer.plugin]
# id = "klippee-preset-spike"
# name = "Klippee Preset Round-trip Spike"
# description = "Local, isolated-profile capture/import experiment. No cloud access."
# author = "Klippee"
# version = "0.0.1"
# ///
"""Experimental OrcaSlicer 2.5.0-alpha preset bridge; not a production plugin.

Run only in a disposable --datadir containing klippee-spike-profile.json.
Serialized values deliberately remain opaque: Orca's JSON reader accepts its
own serialized strings for both scalar and vector options (Config.cpp).
"""
from copy import deepcopy
import hashlib
import csv
import json
from pathlib import Path

from capture_core import FORMAT, COLLECTIONS, RUNTIME_ONLY, IDENTITY_KEYS, canonical_value, values, capture


from restore_core import (remap_compatibility, plan_import, import_graph, verify_graph, saved_expectations, verify)


try:
    import orca
except ImportError:
    orca = None

if orca is not None:
    class RoundTrip(orca.script.ScriptPluginCapabilityBase):
        automatic_run_started = False

        def get_name(self):
            return "Klippee: prove preset round-trip"

        def on_lifecycle_event(self, event, context):
            # Opt-in harness only: importing a generated fixture project through
            # Orca's normal loader supplies real unsaved preset edit buffers.
            # No timers, background threads, native setters or UI injection.
            if event not in (orca.LifecycleEvent.ProjectOpened, orca.LifecycleEvent.ObjectAdded) or self.automatic_run_started:
                return
            storage = Path(orca.host.plugin.storage())
            root = next((parent.parent for parent in storage.parents if parent.name == "orca_plugins"), None)
            if root is None or not (root / "klippee-spike-autorun").is_file():
                return
            harness_path = root / "klippee-spike-harness.json"
            harness = json.loads(harness_path.read_text()) if harness_path.is_file() else {}
            if event == orca.LifecycleEvent.ObjectAdded and harness.get("mode") not in {"baseline", "restart", "selected"}:
                return
            self.automatic_run_started = True
            try:
                self.execute()
            except Exception as error:
                storage.joinpath("error.json").write_text(json.dumps({"error": str(error)}), encoding="utf-8")
                raise

        def execute(self):
            storage = Path(orca.host.plugin.storage())
            root = next((parent.parent for parent in storage.parents if parent.name == "orca_plugins"), None)
            if root is None or not (root / "klippee-spike-profile.json").is_file():
                raise ValueError("Run this spike only in its disposable test profile")
            marker = json.loads((root / "klippee-spike-profile.json").read_text())
            if marker != {"disposable": True, "preset_folder": "default"}:
                raise ValueError("Unrecognized disposable profile marker")
            bundle = orca.host.preset_bundle()
            harness_path = root / "klippee-spike-harness.json"
            harness = json.loads(harness_path.read_text()) if harness_path.is_file() else {}
            if harness.get("mode") == "baseline":
                baseline = capture(bundle)
                storage.joinpath("baseline.json").write_text(json.dumps(baseline), encoding="utf-8")
                orca.host.plater().export_3mf_copy(str(storage / "baseline.3mf"))
                storage.joinpath("baseline-ready.json").write_text(json.dumps({
                    "selections": [{"node": item["node"], "slot": item["slot"]}
                                   for item in baseline["selections"]],
                    "ancestry_nodes": len(baseline["nodes"]),
                }), encoding="utf-8")
                return orca.ExecutionResult.success("Private baseline exported")
            if harness.get("mode") in {"restart", "selected"}:
                expected = json.loads(storage.joinpath("expected.json").read_text(encoding="utf-8"))
                ancestors = json.loads(storage.joinpath("ancestor-expected.json").read_text(encoding="utf-8"))
                graph = json.loads(storage.joinpath("graph.json").read_text(encoding="utf-8"))
                failures = verify(bundle, expected) + verify(bundle, ancestors) + verify_graph(bundle, graph)
                selected = capture(bundle)
                details = [{"node": item["node"], "slot": item["slot"]} for item in selected["selections"]]
                compatibility = []
                if harness["mode"] == "selected":
                    requested = list(expected)
                    if [item["node"] for item in details] != requested:
                        failures.append({"error": "Native selection fell back from the requested imported setup"})
                    for item in selected["selections"]:
                        kind, name = item["node"].split(":", 1)
                        preset = getattr(bundle, COLLECTIONS[kind]).find_preset(name)
                        compatibility.append({"node": item["node"], "compatible": bool(preset.is_compatible)})
                        if not preset.is_compatible:
                            failures.append({"preset": name, "error": "Selected preset is incompatible"})
                        wanted = expected.get(item["node"])
                        if wanted is not None:
                            for key in (set(wanted) | set(item["effective"])) - IDENTITY_KEYS - RUNTIME_ONLY:
                                if canonical_value(key, wanted.get(key)) != canonical_value(key, item["effective"].get(key)):
                                    failures.append({"preset": name, "key": key, "error": "Selected effective value changed"})
                if harness["mode"] == "selected" and not failures:
                    orca.host.plater().export_3mf_copy(str(storage / "selected.3mf"))
                result_name = "selection-result.json" if harness["mode"] == "selected" else "restart-result.json"
                storage.joinpath(result_name).write_text(json.dumps({
                    "passed": not failures, "failures": failures,
                    "graph_nodes_verified": len(graph),
                    "selections": details, "compatibility": compatibility,
                }), encoding="utf-8")
                return orca.ExecutionResult.success("Restart verification recorded")
            before = capture(bundle)
            storage.joinpath("capture.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
            digest = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()[:16]
            bundle_id = "klippee-spike-" + digest
            stages, expected = plan_import(before, bundle_id)
            graph = import_graph(stages)
            ancestors = saved_expectations(before, graph)
            storage.joinpath("expected.json").write_text(json.dumps(expected), encoding="utf-8")
            storage.joinpath("ancestor-expected.json").write_text(json.dumps(ancestors), encoding="utf-8")
            storage.joinpath("graph.json").write_text(json.dumps(graph), encoding="utf-8")
            for stage in stages:
                target = root / "user" / "default" / "_local" / stage["bundle_id"]
                if target.exists():
                    raise ValueError("This capture already exists; change a setting before repeating")
                target.mkdir(parents=True)
                for relative, content in stage["files"].items():
                    path = target / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(content, indent=2, ensure_ascii=False), encoding="utf-8")
                orca.host.preset.bundles.reload_local(stage["bundle_id"])
            failures = verify(bundle, expected) + verify(bundle, ancestors) + verify_graph(bundle, graph)
            after = capture(bundle)
            if before != after:
                failures.append({"error": "Live selections or edits changed during import"})
            app_info = orca.host.app_info()
            report = {"host_version": app_info["version"], "host_build": app_info["build"],
                      "bundle_id": bundle_id,
                      "settings_compared": sum(len(set(config) - IDENTITY_KEYS - RUNTIME_ONLY) for config in expected.values()),
                      "presets_compared": len(expected),
                      "dirty_selections": sum(item["dirty"] for item in before["selections"]),
                      "excluded_runtime_keys": sorted(RUNTIME_ONLY),
                      "normalized_keys": ["thumbnails"],
                      "ancestor_settings_compared": sum(len(set(config) - IDENTITY_KEYS - RUNTIME_ONLY) for config in ancestors.values()),
                      "reload_stages": len(stages), "live_state_preserved": before == after,
                      "failures": failures, "passed": not failures}
            storage.joinpath("result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            if failures:
                raise ValueError("Native round-trip failed; see plugin storage/result.json")
            return orca.ExecutionResult.success(json.dumps(report))

    @orca.plugin
    class KlippeePresetSpike(orca.base):
        def register_capabilities(self):
            orca.register_capability(RoundTrip)
