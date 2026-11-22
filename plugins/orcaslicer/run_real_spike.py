"""Private local QIDI/multislot/restart probe. Retains summary evidence only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import zipfile

from prepare_spike import prepare
from run_spike import STL


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def project_copy(source, target, configuration=None):
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output:
        for entry in archive.infolist():
            if entry.filename == "Metadata/project_settings.config":
                if configuration is not None:
                    output.writestr(entry, json.dumps(configuration).encode())
            elif not entry.filename.startswith(("Metadata/filament_settings_", "Metadata/print_settings_", "Metadata/printer_settings_")):
                output.writestr(entry, archive.read(entry))


def wait_result(process, storage, filename):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        path = storage / filename
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        if (storage / "error.json").is_file():
            raise RuntimeError((storage / "error.json").read_text(encoding="utf-8"))
        if process.poll() is not None:
            raise RuntimeError("Test instance exited before " + filename)
        time.sleep(0.5)
    raise TimeoutError("No native result: " + filename)


def stop(process):
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=20)


def safe_failures(failures):
    # Real presets may contain host addresses, credentials or private G-code.
    return [{key: value for key, value in failure.items() if key in {"preset", "key", "error"}}
            for failure in failures]


def run(orca, source, report_path, select_imported=False, slice_imported=False):
    startup = None
    if hasattr(subprocess, "STARTUPINFO"):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    source = source.resolve()
    config = json.JSONDecoder().raw_decode((source / "OrcaSlicer.conf").read_text(encoding="utf-8"))[0]
    printer = config["presets"]["machine"]
    selection = next(item for item in config["orca_presets"] if item["machine"] == printer)
    slot_names = [selection["filament"]]
    while "filament_" + str(len(slot_names)).zfill(2) in selection:
        slot_names.append(selection["filament_" + str(len(slot_names)).zfill(2)])
    if len(slot_names) < 2:
        raise ValueError("The selected saved setup must contain multiple filament slots")
    output = Path("output").resolve()
    output.mkdir(exist_ok=True)
    source_hashes = {}
    with tempfile.TemporaryDirectory(prefix="orca-real-", dir=output) as temporary:
        scratch = Path(temporary)
        runtime_temp = scratch / "runtime-temp"
        runtime_temp.mkdir()
        environment = {**os.environ, "TEMP": str(runtime_temp), "TMP": str(runtime_temp)}
        stl = scratch / "fixture.stl"
        stl.write_text(STL)
        template = scratch / "template.3mf"
        subprocess.run([str(orca), "--datadir", str(scratch / "cli"), "--export-3mf", str(template), str(stl)],
                       env=environment, startupinfo=startup, timeout=90, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        root = prepare(scratch / "profile")
        # Install the actual distributable with an additional test-only capability.
        production = Path("public/install/klippee_orca.py").read_text(encoding="utf-8")
        probe = Path(__file__).with_name("native_plugin_probe.py").read_text(encoding="utf-8")
        production = production.replace("            orca.register_capability(KlippeeCapture)",
                                        "            orca.register_capability(KlippeeCapture)\n            orca.register_capability(NativeCaptureProbe)")
        plugin_directory = root / "orca_plugins/klippee"
        plugin_directory.mkdir()
        (plugin_directory / "klippee.py").write_text(production + "\n" + probe, encoding="utf-8")
        write_json(plugin_directory / ".install_state.json", {"enabled": True})
        # Remove only the synthetic fixtures just created by prepare().
        shutil.rmtree(root / "user")
        for kind in ("machine", "process", "filament"):
            for path in (source / "user/default" / kind).glob("*.json"):
                destination = root / "user/default" / kind / path.name
                data = path.read_bytes()
                source_hashes[path] = hashlib.sha256(data).hexdigest()
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
        for path in (source / "system").glob("*.opc"):
            data = path.read_bytes()
            source_hashes[path] = hashlib.sha256(data).hexdigest()
            destination = root / "system" / path.name
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(data)
        isolated = json.JSONDecoder().raw_decode((root / "OrcaSlicer.conf").read_text())[0]
        isolated.update({"models": config.get("models", []), "filaments": config.get("filaments", []),
                         "presets": {"machine": printer, "filaments": str(len(slot_names))},
                         "orca_presets": [selection]})

        def save_config(value):
            raw = json.dumps(value, indent=2).encode()
            (root / "OrcaSlicer.conf").write_bytes(raw + b"\n# MD5 checksum " + hashlib.md5(raw).hexdigest().upper().encode() + b"\n")

        save_config(isolated)
        # A bare mesh adds geometry without invoking Orca's project-config
        # loader, so startup's real preset selections remain authoritative.
        trigger = stl
        (root / "klippee-spike-autorun").touch()
        storage = root / "orca_plugins/plugin_data/klippee_preset_spike"

        def phase(mode, filename, project):
            write_json(root / "klippee-spike-harness.json", {"mode": mode})
            if (storage / "error.json").exists():
                (storage / "error.json").unlink()
            process = subprocess.Popen([str(orca), "--datadir", str(root), str(project)],
                                       env=environment, startupinfo=startup,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                return wait_result(process, storage, filename)
            finally:
                stop(process)

        print("Reading copied QIDI setup through native host", flush=True)
        baseline_summary = phase("baseline", "baseline-ready.json", trigger)
        baseline = json.loads((storage / "baseline.json").read_text(encoding="utf-8"))
        actual_names = [item["node"].split(":", 1)[1] for item in baseline["selections"]]
        if actual_names != [printer, selection["process"], *slot_names]:
            raise RuntimeError("Native baseline did not retain the selected printer/process/slot order: " + repr(actual_names))
        baseline_project = storage / "baseline.3mf"
        with zipfile.ZipFile(baseline_project) as archive:
            project_config = json.loads(archive.read("Metadata/project_settings.config"))
        # Generate unsaved edits from the real native project, not synthetic defaults.
        original_height = project_config["layer_height"]
        original_temperatures = list(project_config["nozzle_temperature"])
        project_config["layer_height"] = str(round(float(original_height) + 0.01, 4))
        project_config["nozzle_temperature"][0] = str(int(original_temperatures[0]) + 1)
        differences = project_config.setdefault("different_settings_to_system", [""] * (len(slot_names) + 2))
        differences[0] += ";layer_height"
        differences[1] += ";nozzle_temperature"
        edited_project = root / "edited.3mf"
        project_copy(baseline_project, edited_project, project_config)
        print("Capturing and importing four-slot live state", flush=True)
        imported = phase("roundtrip", "result.json", edited_project)
        capture = json.loads((storage / "capture.json").read_text(encoding="utf-8"))
        graph = json.loads((storage / "graph.json").read_text(encoding="utf-8"))
        slot_evidence = [{"slot": item["slot"], "preset": item["node"].split(":", 1)[1],
                          "temperature": item["effective"].get("nozzle_temperature"), "dirty": item["dirty"]}
                         for item in capture["selections"] if item["slot"] is not None]
        slot_order_preserved = [item["preset"] for item in slot_evidence] == slot_names
        process_edit = next(item for item in capture["selections"] if item["node"].startswith("process:"))
        edit_buffers_verified = (process_edit["dirty"] and slot_evidence[0]["dirty"]
                                 and process_edit["effective"]["layer_height"] == project_config["layer_height"]
                                 and slot_evidence[0]["temperature"] == project_config["nozzle_temperature"][0])
        other_slot_temperatures_preserved = [item["temperature"] for item in slot_evidence[1:]] == original_temperatures[1:]
        imported["failures"] = safe_failures(imported["failures"])
        report = {"printer": printer, "process": selection["process"], "slots": slot_evidence,
                  "baseline": baseline_summary, "import": imported,
                  "ancestry_nodes": len(capture["nodes"]), "imported_graph_nodes": len(graph),
                  "slot_order_preserved": slot_order_preserved,
                  "edit_buffers_verified": bool(edit_buffers_verified),
                  "other_slot_temperatures_preserved": other_slot_temperatures_preserved}
        native_plugin = root / "orca_plugins/plugin_data/klippee/native-plugin-result.json"
        if native_plugin.is_file():
            report["plugin"] = json.loads(native_plugin.read_text(encoding="utf-8"))
            imported["passed"] = imported["passed"] and report["plugin"]["passed"]
        else:
            imported["passed"] = False
            imported["failures"].append({"error": "Production plugin did not complete native verification"})
        write_json(report_path, report)
        if not imported["passed"]:
            return report
        print("Restarting without repairing or re-importing bundles", flush=True)
        bundle_files = list((root / "user/default/_local").rglob("*.json"))
        disk_before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in bundle_files}
        restarted = phase("restart", "restart-result.json", trigger)
        restarted["failures"] = safe_failures(restarted["failures"])
        disk_after = {path: hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in (root / "user/default/_local").rglob("*.json")}
        restarted["bundle_files_unchanged"] = disk_after == disk_before
        restarted["original_slot_selection_preserved"] = restarted["selections"] == baseline_summary["selections"]
        report["restart"] = restarted
        report["source_presets_unchanged"] = all(hashlib.sha256(path.read_bytes()).hexdigest() == digest
                                                for path, digest in source_hashes.items())
        report["passed"] = all((imported["passed"], restarted["passed"], restarted["bundle_files_unchanged"],
                                report["source_presets_unchanged"], slot_order_preserved, edit_buffers_verified,
                                other_slot_temperatures_preserved, restarted["original_slot_selection_preserved"]))
        if select_imported and report["passed"]:
            expected = json.loads((storage / "expected.json").read_text(encoding="utf-8"))
            names = [identity.split(":", 1)[1] for identity in expected]
            selected_config = json.JSONDecoder().raw_decode((root / "OrcaSlicer.conf").read_text(encoding="utf-8"))[0]
            selected_setup = dict(selection)
            selected_setup.update(machine=names[0], process=names[1], filament=names[2])
            for slot, name in enumerate(names[3:], 1):
                selected_setup["filament_" + str(slot).zfill(2)] = name
            selected_config["presets"] = {"machine": names[0], "filaments": str(len(names) - 2)}
            selected_config["orca_presets"] = [selected_setup]
            save_config(selected_config)
            print("Selecting the entire imported setup through native startup", flush=True)
            chosen = phase("selected", "selection-result.json", trigger)
            chosen["failures"] = safe_failures(chosen["failures"])
            report["imported_selection"] = chosen
            report["passed"] = report["passed"] and chosen["passed"]
            write_json(report_path, report)
            if chosen["passed"]:
                # Do not rewrite the app config: require Orca's own persisted
                # selection to survive another fresh process.
                (storage / "selection-result.json").unlink()
                print("Restarting with the same imported selections", flush=True)
                persisted = phase("selected", "selection-result.json", trigger)
                persisted["failures"] = safe_failures(persisted["failures"])
                report["imported_selection_restart"] = persisted
                report["passed"] = report["passed"] and persisted["passed"]
        if slice_imported and report["passed"]:
            from slice_probe import slice_slots
            report["slicing"] = slice_slots(orca, root, storage, scratch, environment, startup)
            report["passed"] = report["passed"] and report["slicing"]["passed"]
        report["source_presets_unchanged"] = all(hashlib.sha256(path.read_bytes()).hexdigest() == digest
                                                for path, digest in source_hashes.items())
        report["passed"] = report["passed"] and report["source_presets_unchanged"]
        write_json(report_path, report)
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orca", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--select-imported", action="store_true")
    parser.add_argument("--slice-imported", action="store_true")
    args = parser.parse_args()
    result = run(args.orca.resolve(), args.source, args.report.resolve(), args.select_imported or args.slice_imported, args.slice_imported)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result.get("passed") else 1)
