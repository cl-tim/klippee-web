"""Native restore planning and verification, shared with the disposable spike."""
from copy import deepcopy
import csv
import hashlib
import json
import re
import uuid
from pathlib import Path
from capture_core import FORMAT, COLLECTIONS, RUNTIME_ONLY, IDENTITY_KEYS, canonical_value, values, capture

PROFILE_FORMAT = "klippee-orca-profile/v1"

PRIVATE_KEY = re.compile(r"password|passwd|secret|token|api_?key|access_?code|printhost|print_host|host_type|authorization|^(setting_id|base_id|user_id)$", re.I)


def comparison_keys(actual, wanted):
    # Captures deliberately omit connection/account options. Orca reinstates
    # native defaults on load; those absent fields are outside the saved setup.
    return {key for key in (set(actual) | set(wanted)) - IDENTITY_KEYS - RUNTIME_ONLY
            if key in wanted or not PRIVATE_KEY.search(key)}


def validate_restore(document):
    """Validate an untrusted exported JSON file before planning any disk writes."""
    if not isinstance(document, dict):
        raise ValueError("Choose an exported Klippee setup JSON file.")
    snapshot = document.get("snapshot")
    if not isinstance(snapshot, dict) or snapshot.get("format") not in (FORMAT, PROFILE_FORMAT):
        raise ValueError("Unsupported Klippee setup file.")
    individual = snapshot["format"] == PROFILE_FORMAT
    nodes = snapshot.get("nodes")
    selections = snapshot.get("selections")
    if not isinstance(nodes, dict) or not 1 <= len(nodes) <= 128 or not isinstance(selections, list) or not (len(selections) == 1 if individual else 3 <= len(selections) <= 34):
        raise ValueError("Invalid setup size or filament slots.")

    def settings(value):
        return isinstance(value, dict) and len(value) <= 4096 and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items())

    # Validate parent shapes first so ancestry walking never follows an unchecked value.
    for node in nodes.values():
        if not isinstance(node, dict) or "parent" not in node or node["parent"] is not None and not isinstance(node["parent"], str):
            raise ValueError("Invalid preset parent.")
    for identity, node in nodes.items():
        if not isinstance(node, dict) or node.get("kind") not in COLLECTIONS or not isinstance(node.get("name"), str) or not 1 <= len(node["name"]) <= 512 or identity != node["kind"] + ":" + node["name"]:
            raise ValueError("Invalid preset identity.")
        if not settings(node.get("saved")) or not (node.get("source_json") is None or isinstance(node["source_json"], dict)):
            raise ValueError("Invalid preset settings.")
        if "parent" not in node or node["parent"] is not None and not isinstance(node["parent"], str):
            raise ValueError("Invalid preset parent.")
        parent = node["parent"]
        if parent is not None and (parent not in nodes or not isinstance(nodes[parent], dict) or nodes[parent].get("kind") != node["kind"]):
            raise ValueError("Missing preset parent.")
        if node["saved"].get("inherits", "") != (nodes[parent].get("name") if parent else ""):
            raise ValueError("Preset inheritance does not match its parent.")
        seen = {identity}
        while parent is not None:
            if parent not in nodes or parent in seen or not isinstance(nodes[parent], dict):
                raise ValueError("Missing or cyclic preset ancestry.")
            seen.add(parent)
            parent = nodes[parent].get("parent")
    reachable = set()
    for index, item in enumerate(selections):
        if not isinstance(item, dict) or not isinstance(item.get("node"), str) or item["node"] not in nodes or type(item.get("dirty")) is not bool:
            raise ValueError("Invalid selected preset.")
        node = nodes[item["node"]]
        kind = node["kind"] if individual else "machine" if index == 0 else "process" if index == 1 else "filament"
        slot = None if individual or index < 2 else index - 2
        if node["kind"] != kind or item.get("slot") != slot or isinstance(item.get("slot"), bool):
            raise ValueError("Invalid printer, process or filament order.")
        if not settings(item.get("effective")) or not settings(item.get("changes")) or not set(node["saved"]) <= set(item["effective"]):
            raise ValueError("Invalid captured edits.")
        if item["effective"].get("inherits", "") != node["saved"].get("inherits", ""):
            raise ValueError("Edited inheritance is unsupported.")
        if individual and (item["dirty"] or item["effective"] != node["saved"]):
            raise ValueError("Individual profiles must contain saved settings, without setup edits.")
        # Derive deltas ourselves; never trust file-provided import instructions.
        item["changes"] = {k: v for k, v in item["effective"].items() if k not in RUNTIME_ONLY and node["saved"].get(k) != v}
        at = item["node"]
        while at is not None and at not in reachable:
            reachable.add(at)
            at = nodes[at]["parent"]
    if reachable != set(nodes):
        raise ValueError("Setup contains unrelated presets.")
    return snapshot


def restore_user_directory(bundle, storage):
    root = next((p.parent for p in Path(storage).resolve().parents if p.name == "orca_plugins"), None)
    if root is None:
        raise ValueError("Could not locate Orca's preset directory.")
    users = (root / "user").resolve()
    for kind in ("machine", "process", "filament"):
        preset = getattr(bundle, COLLECTIONS[kind]).get_selected_preset()
        if preset.file:
            try:
                relative = Path(preset.file).resolve().relative_to(users)
            except ValueError:
                continue
            if len(relative.parts) >= 3:
                return users / relative.parts[0]
    raise ValueError("Select a saved user printer or process preset before restoring.")


def prepare_restore(snapshot):
    """Pure planning; safe to run in a worker without live host handles or I/O."""
    bundle_id = "klippee-restore-" + uuid.uuid4().hex[:12]
    stages, expected = plan_import(snapshot, bundle_id, friendly=True)
    graph = import_graph(stages)
    return {"bundle_id": bundle_id, "stages": stages, "expected": expected,
            "ancestors": saved_expectations(snapshot, graph), "graph": graph,
            "names": [identity.split(":", 1)[1] for identity in expected], "nodes": len(graph),
            "profile": snapshot.get("format") == PROFILE_FORMAT,
            "kinds": [identity.split(":", 1)[0] for identity in expected]}


def restore_steps(plan, user, before, get_bundle, reload_local):
    """One audited file/native operation per tick; never retain a live host view."""
    local = user / "_local"
    bundle_id = plan["bundle_id"]
    if not local.resolve().is_relative_to(user.resolve()):
        raise ValueError("Orca's local preset directory points outside the active user folder.")
    local.mkdir(exist_ok=True)
    for stage in plan["stages"]:
        target = local / stage["bundle_id"]
        if target.exists():
            raise ValueError("Restore name already exists. Review and retry.")
        for relative in stage["files"]:
            if not (target / relative).resolve().is_relative_to(target.resolve()):
                raise ValueError("Invalid restore path.")
            yield "Checking restore paths…"
    try:
        for stage in plan["stages"]:
            target = local / stage["bundle_id"]
            target.mkdir()
            yield "Creating separate preset copies…"
            for relative, content in stage["files"].items():
                path = target / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
                yield "Writing preset copies…"
        for stage in plan["stages"]:
            reload_local(stage["bundle_id"])
            yield "Loading restored presets…"
        for expected in (plan["expected"], plan["ancestors"]):
            for identity, settings in expected.items():
                bundle = get_bundle()
                failures = verify(bundle, {identity: settings}) + verify_graph(bundle, {identity: plan["graph"][identity]})
                del bundle
                if failures:
                    raise ValueError("Native settings verification failed.")
                yield "Checking restored settings and inheritance…"
        if capture(get_bundle()) != before:
            raise ValueError("The active setup changed during restore. Review and restore again.")
    except Exception as error:
        raise ValueError("Restore did not finish verification. Copies may remain under " + bundle_id + "; do not use them. Your original presets were not overwritten.") from error
    return {key: value for key, value in plan.items() if key != "stages"}


def restore_setup(snapshot, bundle, storage, reload_local):
    """Synchronous adapter for the disposable spike; the page advances ticks."""
    before = capture(bundle)
    steps = restore_steps(prepare_restore(snapshot), restore_user_directory(bundle, storage), before, lambda: bundle, reload_local)
    while True:
        try:
            next(steps)
        except StopIteration as done:
            return done.value


def remap_compatibility(config, snapshot, graph):
    """Retain original targets and add copied descendants explicitly.

    Orca 2.5 checks only the immediate printer parent, so translating a root
    name alone loses compatibility once capture adds another inheritance level.
    Never broaden an empty list or change a condition expression.
    """
    for key, kind in (("compatible_printers", "machine"), ("compatible_prints", "process")):
        value = config.get(key)
        if not value:
            continue
        targets = list(value) if isinstance(value, list) else next(csv.reader([value], delimiter=";", escapechar="\\"))
        additions = []
        for target in graph:
            if not target.startswith(kind + ":"):
                continue
            basename = target.rsplit("/", 1)[1]
            identity = None
            for original in snapshot["nodes"]:
                digest = hashlib.sha256(original.encode()).hexdigest()[:20]
                if basename.endswith("saved-" + digest):
                    identity = original
                    break
            while identity:
                node = snapshot["nodes"][identity]
                if node["name"] in targets:
                    additions.append(target.split(":", 1)[1])
                    break
                identity = node["parent"]
        additions = [name for name in additions if name not in targets]
        if additions:
            config[key] = targets + additions if isinstance(value, list) else value + ";" + ";".join(additions)
    return config


def plan_import(snapshot, bundle_id, friendly=False):
    """Build a new namespaced bundle, preserving the ancestry graph.

    Each selection gets a separate child of its captured saved preset. This
    retains both the saved state and explicit unsaved overrides, including the
    distinction when the same filament occurs in multiple slots.
    """
    if snapshot.get("format") not in (FORMAT, PROFILE_FORMAT):
        raise ValueError("Unsupported snapshot format")
    if not bundle_id or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in bundle_id):
        raise ValueError("Bundle id must contain lowercase letters, digits or hyphens")
    nodes = snapshot["nodes"]
    depths = {}

    def depth(identity, trail=()):
        if identity in trail:
            raise ValueError("Cyclic captured ancestry")
        if identity not in nodes:
            raise ValueError("Missing captured parent: " + identity)
        parent = nodes[identity]["parent"]
        if identity not in depths:
            depths[identity] = depth(parent, trail + (identity,)) + 1 if parent else 0
        return depths[identity]

    for identity in nodes:
        depth(identity)
    final_depth = max(depths.values()) + 1
    prefix = lambda level: "_local/" + bundle_id + "-d" + str(level) + "/"
    names = {identity: "saved-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
             for identity in nodes}
    stages = [{"bundle_id": bundle_id + "-d" + str(level), "files": {}}
              for level in range(final_depth + 1)]
    expected = {}
    for stage in stages:
        stage["files"]["bundle_metadata.json"] = {
            "id": stage["bundle_id"], "name": "Klippee restored setup", "version": "1.1.0",
            "print_presets": [], "filament_presets": [], "printer_presets": []}
    list_keys = {"machine": "printer_presets", "process": "print_presets", "filament": "filament_presets"}

    def add(level, kind, name, document):
        document.update(name=name, type=kind, version="2.5.0.0", **{"from": "User"})
        files = stages[level]["files"]
        files[kind + "/" + name + ".json"] = document
        files["bundle_metadata.json"][list_keys[kind]].append(name)

    for identity, node in nodes.items():
        parent_id = node["parent"]
        if parent_id is not None and parent_id not in nodes:
            raise ValueError("Missing captured parent: " + parent_id)
        parent_config = nodes[parent_id]["saved"] if parent_id else {}
        document = deepcopy(node["source_json"]) if node["source_json"] is not None else {}
        # Project loading can put a filament override into the collection's
        # preset while its file still describes the old saved state. Reconcile
        # using the native effective delta, rather than exporting stale disk
        # values. Keep unknown source fields and retain source_json separately.
        document.update({key: value for key, value in node["saved"].items()
                         if key != "inherits" and key not in RUNTIME_ONLY
                         and parent_config.get(key) != value})
        document["inherits"] = prefix(depths[parent_id]) + names[parent_id] if parent_id else ""
        # Cloud identity is not valid for a newly-created local copy.
        for key in ("setting_id", "base_id", "user_id"):
            document.pop(key, None)
        add(depths[identity], node["kind"], names[identity], document)

    for index, selection in enumerate(snapshot["selections"]):
        identity = selection["node"]
        node = nodes[identity]
        name = "captured-" + str(index) + "-" + names[identity]
        if friendly:
            label = re.sub(r"[^a-zA-Z0-9._-]+", "-", node["name"]).strip(".-")[:70] or node["kind"]
            name = "restored-" + str(index) + "-" + label
        document = {"inherits": prefix(depths[identity]) + names[identity], **selection["changes"]}
        add(final_depth, node["kind"], name, document)
        config = deepcopy(selection["effective"])
        config["inherits"] = document["inherits"]
        expected[node["kind"] + ":" + prefix(final_depth) + name] = config
    graph = import_graph(stages)
    for stage in stages:
        for filename, document in stage["files"].items():
            if filename != "bundle_metadata.json":
                remap_compatibility(document, snapshot, graph)
    for config in expected.values():
        remap_compatibility(config, snapshot, graph)
    return stages, expected


def import_graph(stages):
    return {document["type"] + ":_local/" + stage["bundle_id"] + "/" + document["name"]:
            document["inherits"]
            for stage in stages for filename, document in stage["files"].items()
            if filename != "bundle_metadata.json"}


def verify_graph(bundle, graph):
    failures = []
    for identity, parent in graph.items():
        kind, name = identity.split(":", 1)
        collection = getattr(bundle, COLLECTIONS[kind])
        preset = collection.find_preset(name)
        if preset is None or preset.name != name:
            failures.append({"preset": name, "error": "ancestry node missing"})
        elif preset.config_value("inherits") != parent:
            failures.append({"preset": name, "error": "inheritance edge changed"})
        elif parent:
            ancestor = collection.find_preset(parent)
            if ancestor is None or ancestor.name != parent:
                failures.append({"preset": name, "error": "ancestor missing"})
    return failures


def saved_expectations(snapshot, graph):
    expected = {}
    for identity, node in snapshot["nodes"].items():
        basename = "saved-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
        target = next(key for key in graph if key.startswith(node["kind"] + ":") and key.endswith("/" + basename))
        config = deepcopy(node["saved"])
        config["inherits"] = graph[target]
        expected[target] = remap_compatibility(config, snapshot, graph)
    return expected


def verify(bundle, expected):
    """Compare every exposed effective setting after the NATIVE host reload."""
    failures = []
    for identity, wanted in expected.items():
        kind, name = identity.split(":", 1)
        preset = getattr(bundle, COLLECTIONS[kind]).find_preset(name)
        if preset is None or preset.name != name:
            failures.append({"preset": name, "error": "not loaded"})
            continue
        actual = values(preset)
        # Preset identities are intentionally namespaced; these are not settings.
        for key in sorted(comparison_keys(actual, wanted)):
            if canonical_value(key, actual.get(key)) != canonical_value(key, wanted.get(key)):
                failures.append({"preset": name, "key": key,
                                 "expected": wanted.get(key), "actual": actual.get(key)})
    return failures
