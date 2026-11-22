"""Verify an exported setup with the production plugin in disposable native Orca processes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from klippee_plugin import sanitize_capture
from prepare_spike import prepare
from run_real_spike import stop, wait_result, write_json
from run_spike import STL


def run(orca, source, exported, report_path, individual=False):
    startup = None
    if hasattr(subprocess, "STARTUPINFO"):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    source = source.resolve()
    original_config = json.JSONDecoder().raw_decode((source / "OrcaSlicer.conf").read_text(encoding="utf-8"))[0]
    source_hashes = {}
    with tempfile.TemporaryDirectory(prefix="orca-restore-", dir=Path("output").resolve()) as temporary:
        scratch = Path(temporary)
        root = prepare(scratch / "profile")
        # Disable the legacy spike capability; this proof drives production code only.
        write_json(root / "orca_plugins/klippee_preset_spike/.install_state.json", {"enabled": False})
        runtime = scratch / "temp"
        runtime.mkdir()
        environment = {**os.environ, "TEMP": str(runtime), "TMP": str(runtime)}
        trigger = scratch / "test.stl"
        trigger.write_text(STL)
        (root / "saved-setup.json").write_bytes(exported.read_bytes())
        for kind in ("machine", "process", "filament"):
            for path in (source / "user/default" / kind).glob("*.json"):
                data = path.read_bytes()
                source_hashes[path] = hashlib.sha256(data).hexdigest()
                # Same credential filter as the release; never copy printer hosts.
                document = json.loads(data)
                shell = {"nodes": {"fixture": {"saved": {}, "source_json": document}}, "selections": []}
                clean, _ = sanitize_capture(shell)
                write_json(root / "user/default" / kind / path.name, clean["nodes"]["fixture"]["source_json"])
        for path in (source / "system").glob("*.opc"):
            destination = root / "system" / path.name
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(path.read_bytes())
        config = json.JSONDecoder().raw_decode((root / "OrcaSlicer.conf").read_text())[0]
        printer = original_config["presets"]["machine"]
        selection = next(item for item in original_config["orca_presets"] if item["machine"] == printer)
        config.update(models=original_config.get("models", []), filaments=original_config.get("filaments", []),
                      presets=original_config["presets"], orca_presets=[selection])

        def save_config(value):
            raw = json.dumps(value, indent=2).encode()
            (root / "OrcaSlicer.conf").write_bytes(raw + b"\n# MD5 checksum " + hashlib.md5(raw).hexdigest().upper().encode() + b"\n")

        save_config(config)
        production = Path("public/install/klippee_orca.py").read_text(encoding="utf-8")
        probe = Path(__file__).with_name("native_individual_probe.py" if individual else "native_restore_probe.py").read_text(encoding="utf-8")
        production = production.replace("            orca.register_capability(KlippeeCapture)",
                                        "            orca.register_capability(KlippeeCapture)\n            orca.register_capability(NativeRestoreProbe)")
        plugin = root / "orca_plugins/klippee"
        plugin.mkdir()
        (plugin / "klippee.py").write_text(production + "\n" + probe, encoding="utf-8")
        write_json(plugin / ".install_state.json", {"enabled": True})
        storage = root / "orca_plugins/plugin_data/klippee"

        def phase(mode):
            write_json(root / "klippee-restore-probe.json", {"mode": mode})
            result_file = storage / "restore-probe-result.json"
            result_file.unlink(missing_ok=True)
            process = subprocess.Popen([str(orca), "--datadir", str(root), str(trigger)],
                                       env=environment, startupinfo=startup,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                result = wait_result(process, storage, result_file.name)
            finally:
                stop(process)
            if not result["passed"]:
                raise RuntimeError(json.dumps(result))
            return result

        print("Restoring the exported QIDI setup through the production page bridge", flush=True)
        report = {"restore": phase("restore"), "printer_actions": 0, "profile": "disposable"}
        files = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / "user/default/_local").rglob("*.json")}
        print("Restarting Orca and checking every restored preset and parent", flush=True)
        report["restart"] = phase("restart")
        if not individual:
            names = report["restore"]["names"]
            selected_config = json.JSONDecoder().raw_decode((root / "OrcaSlicer.conf").read_text(encoding="utf-8"))[0]
            setup = dict(selection)
            setup.update(machine=names[0], process=names[1], filament=names[2])
            for slot, name in enumerate(names[3:], 1):
                setup["filament_" + str(slot).zfill(2)] = name
            selected_config.update(presets={"machine": names[0], "filaments": str(len(names) - 2)}, orca_presets=[setup])
            save_config(selected_config)
            print("Selecting the restored printer, process and all four filament slots", flush=True)
            report["selection"] = phase("selected")
            print("Restarting again without changing selection or preset files", flush=True)
            report["selection_restart"] = phase("selected")
        report["restored_files_unchanged"] = all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in files.items())
        report["original_presets_unchanged"] = all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in source_hashes.items())
        report["passed"] = report["restored_files_unchanged"] and report["original_presets_unchanged"]
        write_json(report_path, report)
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orca", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--export", dest="exported", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.orca.resolve(), args.source, args.exported, args.report)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
