"""Read-only native library proof in a disposable copy of the user's presets."""
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

PROBE = r'''
class LibraryProbe(orca.script.ScriptPluginCapabilityBase):
    ran = False
    def get_name(self): return "Klippee library verification"
    def on_lifecycle_event(self, event, context):
        if self.ran or event not in (orca.LifecycleEvent.ProjectOpened, orca.LifecycleEvent.ObjectAdded): return
        self.ran = True
        storage = Path(orca.host.plugin.storage())
        result = {"passed": False, "printer_actions": 0}
        try:
            import time
            before = capture(orca.host.preset_bundle())
            started = time.monotonic()
            library, omitted = sanitize_capture(capture(orca.host.preset_bundle(), library=True))
            result["capture_ms"] = round((time.monotonic() - started) * 1000)
            assert library["current"] == sanitize_capture(before)[0]
            assert capture(orca.host.preset_bundle()) == before
            expected = []
            for kind, attr in COLLECTIONS.items():
                collection = getattr(orca.host.preset_bundle(), attr)
                for index in range(collection.size()):
                    preset = collection.preset(index)
                    if not preset.is_default and (preset.is_user() or (kind == "machine" and preset.is_visible)):
                        expected.append(kind + ":" + preset.name)
            assert sorted(expected) == sorted(p["node"] for p in library["profiles"])
            result.update(profiles=[{"name": library["nodes"][p["node"]]["name"], "kind": library["nodes"][p["node"]]["kind"],
                                     "custom": p["custom"], "enabled": p["enabled"],
                                     "nozzle": library["nodes"][p["node"]]["saved"].get("nozzle_diameter", "")} for p in library["profiles"]],
                          nodes=len(library["nodes"]), bytes=len(json.dumps(library).encode()),
                          live_state_preserved=True, complete_scope_verified=True)
            (storage / "library-private.json").write_text(json.dumps(library), encoding="utf-8")
            result["passed"] = True
        except Exception as error:
            result["error"] = str(error)
        (storage / "library-result.json").write_text(json.dumps(result), encoding="utf-8")
'''

def run(orca, source, report, export):
    source = source.resolve()
    config = json.JSONDecoder().raw_decode((source / "OrcaSlicer.conf").read_text(encoding="utf-8"))[0]
    hashes = {}
    with tempfile.TemporaryDirectory(prefix="orca-library-", dir=Path("output").resolve()) as temporary:
        scratch = Path(temporary)
        root = prepare(scratch / "profile")
        write_json(root / "orca_plugins/klippee_preset_spike/.install_state.json", {"enabled": False})
        # Remove generated fixture presets so the catalog exactly matches the source.
        import shutil
        fixture_presets = (root / "user/default").resolve()
        if not fixture_presets.is_relative_to(scratch.resolve()) or not (root / "klippee-spike-profile.json").is_file():
            raise ValueError("Refusing to remove presets outside the disposable fixture")
        shutil.rmtree(fixture_presets)
        for path in (source / "user/default").rglob("*.json"):
            if any(part.startswith(".") for part in path.relative_to(source / "user/default").parts): continue
            hashes[path] = hashlib.sha256(path.read_bytes()).hexdigest()
            document = json.loads(path.read_text(encoding="utf-8-sig"))
            clean, _ = sanitize_capture({"nodes": {"fixture": {"saved": {}, "source_json": document}}, "selections": []})
            write_json(root / "user/default" / path.relative_to(source / "user/default"), clean["nodes"]["fixture"]["source_json"])
        for path in (source / "system").glob("*.opc"):
            destination = root / "system" / path.name
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(path.read_bytes())
        seeded = json.JSONDecoder().raw_decode((root / "OrcaSlicer.conf").read_text())[0]
        for key in ("models", "filaments", "presets", "orca_presets"):
            if key in config: seeded[key] = config[key]
        raw = json.dumps(seeded).encode()
        (root / "OrcaSlicer.conf").write_bytes(raw + b"\n# MD5 checksum " + hashlib.md5(raw).hexdigest().upper().encode() + b"\n")
        production = Path("public/install/klippee_orca.py").read_text(encoding="utf-8")
        production = production.replace("            orca.register_capability(KlippeeCapture)", "            orca.register_capability(KlippeeCapture)\n            orca.register_capability(LibraryProbe)")
        plugin = root / "orca_plugins/klippee"
        plugin.mkdir()
        (plugin / "klippee.py").write_text(production + "\n" + PROBE, encoding="utf-8")
        write_json(plugin / ".install_state.json", {"enabled": True})
        trigger = scratch / "test.stl"
        trigger.write_text(STL)
        runtime = scratch / "temp"; runtime.mkdir()
        startup = subprocess.STARTUPINFO() if hasattr(subprocess, "STARTUPINFO") else None
        if startup: startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        process = subprocess.Popen([str(orca), "--datadir", str(root), str(trigger)], env={**os.environ, "TEMP": str(runtime), "TMP": str(runtime)}, startupinfo=startup, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        storage = root / "orca_plugins/plugin_data/klippee"
        try:
            result = wait_result(process, storage, "library-result.json")
            if result["passed"] and export:
                export.write_bytes((storage / "library-private.json").read_bytes())
        finally:
            stop(process)
        result["original_presets_unchanged"] = all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in hashes.items())
        result["passed"] = result["passed"] and result["original_presets_unchanged"]
        write_json(report, result)
        return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orca", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    result = run(args.orca, args.source, args.report, args.export)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
