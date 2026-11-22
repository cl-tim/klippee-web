"""Create a fresh disposable Orca profile; never read the real user profile.

Usage: python plugins/orcaslicer/prepare_spike.py ABSOLUTE_NEW_DIRECTORY
Then launch OrcaSlicer with --datadir ABSOLUTE_NEW_DIRECTORY.
"""
import json
import hashlib
from pathlib import Path
import sys
import zipfile


def prepare(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=False)

    def write(relative, value):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2), encoding="utf-8")

    write("klippee-spike-profile.json", {"disposable": True, "preset_folder": "default"})
    write("OrcaSlicer.conf", {
        "header": "OrcaSlicer 2.5.0-alpha", "firstguide": {"finish": True},
        "app": {"version": "2.5.0-alpha", "preset_folder": "default",
                "single_instance": "false", "show_splash_screen": "false",
                "show_home_page": "false", "show_daily_tips": "false",
                "show_hints": "false", "enable_ota": "false",
                "preset_bundle_auto_update": "false", "stealth_mode": "true",
                "associate_3mf": "false", "associate_stl": "false",
                "associate_step": "false", "associate_gcode": "false"},
        "presets": {"machine": "Klippee Spike Printer", "filaments": "1"},
        "orca_presets": [{"machine": "Klippee Spike Printer",
                          "process": "Klippee Spike Process",
                          "filament": "Klippee Spike Filament", "filament_01": "Klippee Spike Second Filament"}],
    })
    config_path = root / "OrcaSlicer.conf"
    config_bytes = config_path.read_bytes()
    config_path.write_bytes(config_bytes + b"\n# MD5 checksum " +
                            hashlib.md5(config_bytes).hexdigest().upper().encode() + b"\n")
    definitions = {
        "machine": ("Printer", {"printer_technology": "FFF", "printer_model": "Klippee Spike",
                                "nozzle_diameter": ["0.4"], "gcode_flavor": "klipper",
                                "printable_area": ["0x0", "300x0", "300x300", "0x300"],
                                "default_print_profile": "Klippee Spike Process",
                                "default_filament_profile": ["Klippee Spike Filament"]}),
        "process": ("Process", {"layer_height": "0.2", "sparse_infill_density": "15%"}),
        "filament": ("Filament", {"filament_type": ["PLA"], "filament_flow_ratio": ["0.98"],
                                  "nozzle_temperature": ["210"],
                                  "filament_start_gcode": ["; inherited start\nM117 hello; world\n"]}),
    }
    for kind, (label, settings) in definitions.items():
        base = "Klippee Spike Base " + label
        name = "Klippee Spike " + label
        common = {"type": kind, "from": "User", "version": "2.5.0.0", "instantiation": "true"}
        base_ref = "_local/klippee-fixture-base/" + base
        write("user/default/_local/klippee-fixture-base/" + kind + "/" + base + ".json",
              {**common, "name": base, "inherits": "", **settings})
        write("user/default/" + kind + "/" + name + ".json",
              {**common, "name": name, "inherits": base_ref})
        if kind == "filament":
            second = "Klippee Spike Second Filament"
            write("user/default/filament/" + second + ".json",
                  {**common, "name": second, "inherits": base_ref, "nozzle_temperature": ["220"]})
    write("user/default/_local/klippee-fixture-base/bundle_metadata.json",
          {"id": "klippee-fixture-base", "name": "Klippee fixture ancestry", "version": "0.0.1"})
    plugin_dir = root / "orca_plugins" / "klippee_preset_spike"
    plugin_dir.mkdir(parents=True)
    core = Path(__file__).with_name("capture_core.py").read_text(encoding="utf-8")
    script = Path(__file__).with_name("preset_spike.py").read_text(encoding="utf-8")
    script = script.replace("from capture_core import FORMAT, COLLECTIONS, RUNTIME_ONLY, IDENTITY_KEYS, canonical_value, values, capture", core)
    restore = Path(__file__).with_name("restore_core.py").read_text(encoding="utf-8")
    restore = restore.replace("from capture_core import FORMAT, COLLECTIONS, RUNTIME_ONLY, IDENTITY_KEYS, canonical_value, values, capture", "")
    script = script.replace("from restore_core import (remap_compatibility, plan_import, import_graph, verify_graph, saved_expectations, verify)", restore)
    (plugin_dir / "klippee_preset_spike.py").write_text(script, encoding="utf-8")
    write("orca_plugins/klippee_preset_spike/.install_state.json", {
        "plugin_name": "Klippee Preset Round-trip Spike", "installed_version": "0.0.1",
        "enabled": True, "capabilities": [{"Klippee: prove preset round-trip": True}],
    })
    return root


def project_fixture(root, native_template):
    """Alter native project config through the documented 3MF file format.

    Opening it makes Orca's normal project loader reconstruct edit buffers
    against the saved fixture presets. This is not a simulated host setter.
    """
    root = Path(root)
    with zipfile.ZipFile(native_template) as archive:
        config = json.loads(archive.read("Metadata/project_settings.config"))
        for kind in ("machine", "process", "filament"):
            directory = root / "user/default/_local/klippee-fixture-base" / kind
            source = json.loads(next(directory.glob("*.json")).read_text())
            config.update({key: value for key, value in source.items()
                           if key not in {"name", "type", "version", "from", "instantiation", "inherits"}})
        config.update({
            "printer_settings_id": "Klippee Spike Printer", "print_settings_id": "Klippee Spike Process",
            "filament_settings_id": ["Klippee Spike Filament"],
            "inherits_group": ["_local/klippee-fixture-base/Klippee Spike Base Process",
                               "_local/klippee-fixture-base/Klippee Spike Base Filament",
                               "_local/klippee-fixture-base/Klippee Spike Base Printer"],
            "different_settings_to_system": ["layer_height", "nozzle_temperature", ""],
            "layer_height": "0.23", "nozzle_temperature": ["217"],
        })
        target = root / "unsaved-fixture.3mf"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for entry in archive.infolist():
                data = json.dumps(config).encode() if entry.filename == "Metadata/project_settings.config" else archive.read(entry)
                output.writestr(entry, data)
    root.joinpath("klippee-spike-autorun").touch()
    return target


if __name__ == "__main__":
    root = prepare(sys.argv[1])
    print(project_fixture(root, sys.argv[2]) if len(sys.argv) > 2 else root)
