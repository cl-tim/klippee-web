"""Local-only native CLI slicing of the selected imported four-slot project."""
import json
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile


def assign_slot(source, target, slot):
    """Change only the test object's filament assignment (Orca uses 1-based IDs)."""
    if slot < 0:
        raise ValueError("Slot must be nonnegative")
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output:
        if "Metadata/model_settings.config" not in archive.namelist():
            raise ValueError("Missing test object metadata")
        for entry in archive.infolist():
            data = archive.read(entry)
            if entry.filename == "Metadata/model_settings.config":
                model = ET.fromstring(data)
                objects = model.findall("object")
                if len(objects) != 1:
                    raise ValueError("Expected exactly one test object")
                for owner in [objects[0], *objects[0].findall("part")]:
                    metadata = owner.find("metadata[@key='extruder']")
                    if metadata is None:
                        metadata = ET.SubElement(owner, "metadata", {"key": "extruder"})
                    metadata.set("value", str(slot + 1))
                data = ET.tostring(model, encoding="utf-8", xml_declaration=True)
            output.writestr(entry, data)


def gcode_config(text):
    return dict(re.findall(r"^; ([a-zA-Z0-9_]+) = (.*)$", text, re.MULTILINE))


def toolpath_evidence(text, slot, filaments, process, bed_key):
    """Check actual commands and per-slot consumption as well as config comments."""
    usage = re.search(r"^; filament used \[mm\] = (.+)$", text, re.MULTILINE)
    used = [float(value) for value in usage[1].split(",")] if usage else []
    nozzle = [float(value) for value in re.findall(r"^M10[49]\s+S([\d.]+)", text, re.MULTILINE) if float(value) > 0]
    bed = [float(value) for value in re.findall(r"^M1[49]0\s+S([\d.]+)", text, re.MULTILINE) if float(value) > 0]
    heights = [float(value) for value in re.findall(r"^;\s*(?:Z:|Z_HEIGHT:)\s*([\d.]+)", text, re.MULTILINE)]
    filament = filaments[slot]
    checks = {
        "only_requested_slot_extrudes": len(used) == len(filaments) and used[slot] > 0
            and all(value == 0 for index, value in enumerate(used) if index != slot),
        "initial_nozzle_command": bool(nozzle) and nozzle[0] == float(filament["nozzle_temperature_initial_layer"]),
        "normal_nozzle_command": float(filament["nozzle_temperature"]) in nozzle,
        "initial_bed_command": bool(bed) and bed[0] == float(filament[bed_key + "_initial_layer"]),
        "normal_bed_command": float(filament[bed_key]) in bed,
        "initial_layer_z": len(heights) > 2 and abs(heights[0] - float(process["initial_layer_print_height"])) < 1e-5,
        "normal_layer_z_spacing": len(heights) > 2 and all(abs(b - a - float(process["layer_height"])) < 1e-5
            for a, b in zip(heights[:-2], heights[1:-1])),
        "extrusion_moves_present": bool(re.search(r"^G1\s+[^;\n]*[XY][^;\n]*\sE[\d.]+", text, re.MULTILINE)),
    }
    return {"checks": checks, "filament_used_mm": used, "nozzle_commands_c": nozzle,
            "bed_commands_c": bed, "layers": len(heights),
            "layer_height_mm": float(process["layer_height"]),
            "initial_layer_height_mm": float(process["initial_layer_print_height"])}


def slice_slots(orca, root, storage, scratch, environment, startup):
    expected = json.loads((storage / "expected.json").read_text(encoding="utf-8"))
    machine = next(value for key, value in expected.items() if key.startswith("machine:"))
    process = next(value for key, value in expected.items() if key.startswith("process:"))
    filaments = [value for key, value in expected.items() if key.startswith("filament:")]
    with zipfile.ZipFile(storage / "selected.3mf") as archive:
        project_config = json.loads(archive.read("Metadata/project_settings.config"))
    bed_type = project_config["curr_bed_type"]
    bed_key = {"Textured PEI Plate": "textured_plate_temp", "High Temp Plate": "hot_plate_temp",
               "Cool Plate": "cool_plate_temp", "Engineering Plate": "eng_plate_temp"}[bed_type]
    results = []
    for slot in range(len(filaments)):
        print("Slicing imported filament slot " + str(slot + 1) + " locally", flush=True)
        project = scratch / ("slot-" + str(slot + 1) + ".3mf")
        assign_slot(storage / "selected.3mf", project, slot)
        destination = scratch / ("slice-" + str(slot + 1))
        destination.mkdir()
        command = [str(orca), "--datadir", str(root), "--slice", "0", "--outputdir", str(destination),
                   "--export-3mf", "sliced.3mf", str(project)]
        completed = subprocess.run(command, env=environment, startupinfo=startup, timeout=180,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (destination / "private-stdout.log").write_bytes(completed.stdout)
        (destination / "private-stderr.log").write_bytes(completed.stderr)
        # Logs and generated code may contain private macros; retain only allowlisted evidence.
        paths = list(destination.rglob("*.gcode"))
        if not paths and (destination / "sliced.3mf").is_file():
            with zipfile.ZipFile(destination / "sliced.3mf") as archive:
                names = [name for name in archive.namelist() if name.endswith(".gcode")]
                text = archive.read(names[0]).decode("utf-8") if len(names) == 1 else ""
        else:
            text = paths[0].read_text(encoding="utf-8") if len(paths) == 1 else ""
        actual = gcode_config(text)
        keys = ["printer_model", "printer_variant", "nozzle_diameter", "printable_area", "gcode_flavor",
                "machine_max_acceleration_x", "machine_max_acceleration_y", "machine_max_speed_x", "machine_max_speed_y",
                "layer_height", "initial_layer_print_height", "wall_loops", "sparse_infill_density",
                "sparse_infill_pattern", "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "travel_speed"]
        wanted = {**machine, **process}
        checks = {key: key in wanted and actual.get(key) == wanted[key] for key in keys}
        filament_keys = ["nozzle_temperature", "nozzle_temperature_initial_layer", "filament_flow_ratio",
                         "filament_diameter", "filament_density", "filament_max_volumetric_speed", bed_key, bed_key + "_initial_layer"]
        filament_checks = {key: actual.get(key) == ",".join(filament[key] for filament in filaments)
                           for key in filament_keys}
        toolpath = toolpath_evidence(text, slot, filaments, process, bed_key)
        results.append({"slot": slot + 1, "exit_code": completed.returncode, "gcode_generated": bool(text),
                        "settings_checks": checks,
                        "filament_settings_checks": filament_checks, "toolpath": toolpath,
                        "passed": completed.returncode == 0 and bool(text) and all(checks.values())
                            and all(filament_checks.values()) and all(toolpath["checks"].values())})
    return {"passed": all(item["passed"] for item in results), "model": "10 mm tetrahedron",
            "bed_type": bed_type, "local_export_only": True, "slots": results}
