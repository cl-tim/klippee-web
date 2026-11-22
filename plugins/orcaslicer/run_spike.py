"""Run the real Orca host in a disposable profile and retain a small evidence file.

python plugins/orcaslicer/run_spike.py --orca "C:/Program Files/OrcaSlicer/orca-slicer.exe" --report RESULT.json
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from prepare_spike import prepare, project_fixture

STL = """solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 10 0
vertex 10 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 0 10
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 10
vertex 0 10 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 10 0 0
vertex 0 10 0
vertex 0 0 10
endloop
endfacet
endsolid tetrahedron
"""


def run(orca):
    startup = None
    if hasattr(subprocess, "STARTUPINFO"):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    with tempfile.TemporaryDirectory(prefix="klippee-orca-native-") as temporary:
        scratch = Path(temporary)
        runtime_temp = scratch / "runtime-temp"
        runtime_temp.mkdir()
        environment = {**os.environ, "TEMP": str(runtime_temp), "TMP": str(runtime_temp)}
        stl = scratch / "fixture.stl"
        stl.write_text(STL)
        template = scratch / "native-template.3mf"
        subprocess.run([str(orca), "--datadir", str(scratch / "cli"),
                        "--export-3mf", str(template), str(stl)],
                       startupinfo=startup, env=environment, timeout=60, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not template.is_file():
            raise RuntimeError("Orca did not export the native fixture template")
        root = prepare(scratch / "profile")
        project = project_fixture(root, template)
        process = subprocess.Popen([str(orca), "--datadir", str(root), str(project)],
                                   startupinfo=startup, env=environment, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        try:
            storage = root / "orca_plugins/plugin_data/klippee_preset_spike"
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if storage.joinpath("result.json").is_file():
                    report = json.loads(storage.joinpath("result.json").read_text())
                    capture = json.loads(storage.joinpath("capture.json").read_text())
                    report["capture_evidence"] = [
                        {"preset": item["node"], "slot": item["slot"], "dirty": item["dirty"],
                         "changes": item["changes"]} for item in capture["selections"]]
                    process_edit = next(item for item in capture["selections"] if item["node"].startswith("process:"))
                    filament_edit = next(item for item in capture["selections"] if item["node"].startswith("filament:"))
                    if process_edit["changes"].get("layer_height") != "0.23":
                        raise RuntimeError("Fixture did not reconstruct the unsaved layer-height edit")
                    report["process_edit_evidence"] = {
                        "saved_layer_height": capture["nodes"][process_edit["node"]]["saved"]["layer_height"],
                        "captured_effective_layer_height": process_edit["effective"]["layer_height"],
                    }
                    filament_node = capture["nodes"][filament_edit["node"]]
                    while "nozzle_temperature" not in (filament_node["source_json"] or {}):
                        if filament_node["parent"] is None:
                            raise RuntimeError("No source-file temperature baseline in captured ancestry")
                        filament_node = capture["nodes"][filament_node["parent"]]
                    filament_source = filament_node["source_json"]
                    if (filament_edit["effective"].get("nozzle_temperature") != "217"
                            or filament_source.get("nozzle_temperature") != ["210"]):
                        raise RuntimeError("Fixture did not reconstruct the unsaved filament-temperature edit")
                    report["filament_edit_evidence"] = {
                        "source_file_temperature": filament_source["nozzle_temperature"],
                        "captured_effective_temperature": filament_edit["effective"]["nozzle_temperature"],
                    }
                    if not process_edit["dirty"] or not filament_edit["dirty"]:
                        raise RuntimeError("Host did not mark both reconstructed edit buffers dirty")
                    report["ancestry_nodes"] = len(capture["nodes"])
                    report["method"] = "Native 3MF project load, live plugin capture, staged native bundle reload"
                    return report
                if storage.joinpath("error.json").is_file():
                    raise RuntimeError(storage.joinpath("error.json").read_text())
                if process.poll() is not None:
                    raise RuntimeError("Orca exited before producing evidence")
                time.sleep(0.5)
            raise TimeoutError("Native host produced no result within 90 seconds")
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orca", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.orca.resolve())
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "capture_evidence"}, indent=2))
    raise SystemExit(0 if report["passed"] else 1)
