"""Native preset capture shared by the plugin and round-trip spike."""
from pathlib import Path
import json

FORMAT = "klippee-orca-setup/v1"
COLLECTIONS = {"machine": "printers", "process": "prints", "filament": "filaments"}
# Project/runtime inventory absent from the machine preset on native reload.
# Retain it in capture evidence, but do not treat it as a persistent setting.
RUNTIME_ONLY = {"extruder_nozzle_stats"}
IDENTITY_KEYS = {"printer_settings_id", "print_settings_id", "filament_settings_id"}


def canonical_value(key, value):
    # Native preset normalization inserts spaces between thumbnail descriptors;
    # the project loader does not. Compare the descriptor list, not whitespace.
    if key == "thumbnails" and isinstance(value, str):
        return ",".join(part.strip() for part in value.split(","))
    return value


def values(preset):
    result = {key: preset.config_value(key) for key in preset.config_keys()}
    if any(not isinstance(value, str) for value in result.values()):
        raise ValueError("Host returned a non-string configuration value")
    return result


def capture(bundle, library=False):
    """Copy live views immediately; capture saved ancestry and unsaved deltas.

    Never retain native Preset references across callbacks. Unknown source JSON
    fields survive in source_json, even when Orca does not expose them.
    """
    nodes = {}
    saved_presets = {}
    for kind, attribute in COLLECTIONS.items():
        collection = getattr(bundle, attribute)
        saved_presets[kind] = {collection.preset(index).name: collection.preset(index)
                               for index in range(collection.size())}

    def visit(kind, preset, collection, visiting=()):
        identity = kind + ":" + preset.name
        if identity in visiting:
            raise ValueError("Cyclic inheritance: " + identity)
        if identity in nodes:
            return identity
        config = values(preset)
        parent_name = config.get("inherits", "")
        parent_id = None
        if parent_name:
            parent = saved_presets[kind].get(parent_name)
            if parent is None:
                raise ValueError("Missing parent preset: " + parent_name)
            parent_id = visit(kind, parent, collection, visiting + (identity,))
        source = None
        source_path = Path(preset.file) if preset.file else None
        if source_path and source_path.is_file():
            # A present but unreadable/malformed file is an error, never silently
            # replace its metadata with a guessed representation.
            source = json.loads(source_path.read_text(encoding="utf-8").lstrip("\ufeff"))
            if not isinstance(source, dict):
                raise ValueError("Preset file must contain a JSON object")
        nodes[identity] = {
            "kind": kind, "name": preset.name, "parent": parent_id,
            "saved": config, "source_json": source,
        }
        return identity

    selections = []

    def selected(kind, saved, edited, slot=None):
        collection = getattr(bundle, COLLECTIONS[kind])
        identity = visit(kind, saved, collection)
        current = values(edited)
        baseline = nodes[identity]["saved"]
        removed = set(baseline) - set(current)
        if removed:
            raise ValueError("Edited preset removed keys in " + kind + ": " + ", ".join(sorted(removed)))
        if current.get("inherits", "") != baseline.get("inherits", ""):
            raise ValueError("Changing the inheritance parent in memory is unsupported")
        selections.append({
            "node": identity, "slot": slot,
            "dirty": bool(edited.is_dirty), "effective": current,
            "changes": {key: value for key, value in current.items()
                        if value != baseline.get(key) and key not in RUNTIME_ONLY},
        })

    for kind in ("machine", "process"):
        collection = getattr(bundle, COLLECTIONS[kind])
        selected(kind, collection.get_selected_preset(), collection.get_edited_preset())
    filament_collection = bundle.filaments
    edited_filament = filament_collection.get_edited_preset()
    for slot, current in enumerate(bundle.current_filament_presets()):
        if current is None:
            raise ValueError("Missing filament in slot " + str(slot))
        # find_preset(), used by current_filament_presets(), can substitute the
        # live edit buffer. Only collection.preset(index) is a saved baseline.
        saved = saved_presets["filament"].get(current.name)
        if saved is None:
            raise ValueError("Missing saved filament: " + current.name)
        edited = edited_filament if saved.name == edited_filament.name else saved
        selected("filament", saved, edited, slot)
    snapshot = {"format": FORMAT, "nodes": dict(nodes), "selections": selections}
    if not library:
        return snapshot
    profiles = []
    for kind, presets in saved_presets.items():
        for preset in presets.values():
            custom = bool(preset.is_user())
            enabled = bool(preset.is_visible)
            # Compatibility with the current printer is deliberately irrelevant:
            # a filament for another nozzle/printer still belongs in the library.
            if not preset.is_default and (custom or (kind == "machine" and enabled)):
                profiles.append({"node": visit(kind, preset, getattr(bundle, COLLECTIONS[kind])),
                                 "custom": custom, "enabled": enabled})
    return {"format": "klippee-orca-library/v1", "nodes": nodes,
            "profiles": profiles, "current": snapshot}

