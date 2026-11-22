"""Save and restore isolated preset copies. Network work stays off the UI thread."""
from copy import deepcopy
import json
from pathlib import Path
from queue import Empty, Queue
import re
from threading import Thread, Event, Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPHandler, HTTPSHandler, ProxyHandler, Request, build_opener
from http.client import HTTPConnection, HTTPSConnection
import socket
import os
import secrets
import uuid
import sys

from capture_core import capture, IDENTITY_KEYS, RUNTIME_ONLY, canonical_value
from datetime import datetime, timezone

from restore_core import PROFILE_FORMAT, PRIVATE_KEY, comparison_keys, validate_restore, restore_setup, plan_import, import_graph, saved_expectations, verify, verify_graph, prepare_restore, restore_steps, restore_user_directory

MAX_BYTES = 512_000


def sanitize_capture(snapshot):
    if snapshot.get("format") == "klippee-orca-library/v1":
        nodes, omitted = sanitize_capture({"nodes": snapshot["nodes"], "selections": []})
        current, current_omitted = sanitize_capture(snapshot["current"])
        return {**snapshot, "nodes": nodes["nodes"], "current": current}, sorted(set(omitted + current_omitted))
    omitted = set()

    def clean(value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if PRIVATE_KEY.search(key):
                    omitted.add(key)
                else:
                    result[key] = clean(item)
            return result
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    # Only option keys are secrets; a preset name itself may contain "token".
    result = deepcopy(snapshot)
    for node in result["nodes"].values():
        node["saved"] = clean(node["saved"])
        node["source_json"] = clean(node["source_json"])
    for item in result["selections"]:
        item["effective"] = clean(item["effective"])
        item["changes"] = clean(item["changes"])
    return result, sorted(omitted)


def parse_connection(code):
    if not isinstance(code, str) or len(code) > 2048:
        raise ValueError("Paste the connection code from Klippee's Orca Workspace.")
    url = urlsplit(code.strip())
    local = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (url.scheme != "https" and not (url.scheme == "http" and local)) or not url.hostname or url.username or url.password or url.query or url.path not in {"", "/"}:
        raise ValueError("Use a connection code from an HTTPS Klippee site.")
    if not re.fullmatch(r"klorca_[A-Za-z0-9_-]{43}", url.fragment):
        raise ValueError("Connection code is incomplete. Copy it again from Klippee.")
    return url.scheme + "://" + url.netloc, url.fragment


class DisconnectedError(ValueError):
    pass


def saved_connection_path():
    return Path(orca.host.plugin.storage()) / "library-connection.json"


def store_connection(origin, token):
    # SDK-owned private plugin storage; never presets, page JS, or a restore receipt.
    path = saved_connection_path()
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
        json.dump({"origin": origin, "token": token}, file)
    temporary.replace(path)


def load_connection():
    path = saved_connection_path()
    if not path.is_file():
        return None
    if path.stat().st_size > 4096:
        raise ValueError("Saved connection is invalid. Disconnect and connect again.")
    data = json.loads(path.read_text(encoding="utf-8"))
    origin, _ = parse_connection(data["origin"] + "/#klorca_" + "x" * 43)
    token = data["token"]
    if not isinstance(token, str) or not re.fullmatch(r"klorcadevice_[A-Za-z0-9_-]{43}", token):
        raise ValueError("Saved connection is invalid. Disconnect and connect again.")
    return origin, token


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise ValueError("Klippee redirected the request. Create a code at the site's final address.")


class RequestLease:
    """Cancel socket I/O without waiting on a worker or a buffered-reader lock."""
    def __init__(self):
        self.stopped = Event()
        self.lock = Lock()
        self.connection = None

    def check(self):
        if self.stopped.is_set():
            raise ValueError("Request cancelled.")

    def attach(self, connection):
        # urllib can close its socket object while HTTPResponse still owns a
        # file reference. Keep an independent raw descriptor for cancellation,
        # including HTTPS (SSLSocket.dup itself is intentionally unsupported).
        borrowed = socket.socket(connection.family, connection.type, connection.proto, fileno=connection.fileno())
        try:
            borrowed.settimeout(connection.gettimeout())
            controller = borrowed.dup()
        finally:
            borrowed.detach()
        with self.lock:
            self.connection = controller
        if self.stopped.is_set():
            self.cancel()
        self.check()

    def cancel(self):
        self.stopped.set()
        with self.lock:
            connection, self.connection = self.connection, None
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def release(self):
        with self.lock:
            connection, self.connection = self.connection, None
        if connection is not None:
            connection.close()


def make_request(origin, token, path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    limit = 8_000_000 if path == "/api/orca/library" else MAX_BYTES
    if len(body) > limit:
        raise ValueError("Profile library is too large (maximum 8 MB)." if limit > MAX_BYTES else "Setup is too large (maximum 512 KB).")
    return Request(origin + path, data=body, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "Klippee-OrcaSlicer/1.6.0 (+https://klippee.xyz)",
    })


def send_request(request, lease=None):
    lease = lease or RequestLease()
    # No redirects or environment proxies: permission applies to this exact URL.
    class CancellableConnection:
        def connect(self):
            lease.check()
            super().connect()
            lease.attach(self.sock)
        def send(self, data):
            lease.check()
            return super().send(data)
    class Http(CancellableConnection, HTTPConnection):
        pass
    class Https(CancellableConnection, HTTPSConnection):
        pass
    class HttpHandler(HTTPHandler):
        def http_open(self, req):
            return self.do_open(Http, req)
    class HttpsHandler(HTTPSHandler):
        def https_open(self, req):
            return self.do_open(Https, req, context=self._context)
    try:
        lease.check()
        with build_opener(NoRedirect(), ProxyHandler({}), HttpHandler(), HttpsHandler()).open(request, timeout=12) as response:
            limit = 1_000_000 if request.full_url.endswith("/restore/library") else 600_000 if request.full_url.endswith("/restore/profile") else 65_536
            raw = response.read(limit + 1)
            lease.check()
            if len(raw) > limit:
                raise ValueError("Klippee returned an oversized response.")
            return json.loads(raw)
    except HTTPError as error:
        if error.code == 401 and any(path in request.full_url for path in ("/api/orca/restore/", "/api/orca/device/")):
            raise DisconnectedError("This Orca connection expired or was disconnected. Connect again in Klippee.") from None
        if error.code == 401 and any(request.full_url.endswith(path) for path in ("/api/orca/library", "/api/orca/capture")):
            raise ValueError("This upload review expired or was cancelled. Review again in the plugin before saving.") from None
        if error.code in {400, 401, 403, 404, 409, 413, 429}:
            try:
                message = json.loads(error.read(4096)).get("error")
                if isinstance(message, str) and len(message) <= 300:
                    raise ValueError(message) from None
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
        raise ValueError("Klippee could not complete the request. Try again.") from None
    except (URLError, TimeoutError, OSError):
        raise ValueError("Could not reach Klippee. Check your connection and retry.") from None
    finally:
        lease.release()


def request_json(origin, token, path, payload):
    return send_request(make_request(origin, token, path, payload))


def selection_summary(snapshot):
    return [{"name": snapshot["nodes"][item["node"]]["name"], "kind": snapshot["nodes"][item["node"]]["kind"],
             "slot": item["slot"], "dirty": item["dirty"]} for item in snapshot["selections"]]


def validate_restore_document(document):
    snapshot = validate_restore(document)
    snapshot, _ = sanitize_capture(snapshot)
    snapshot = validate_restore({"snapshot": snapshot})
    plan_import(snapshot, "klippee-restore-preview", friendly=True)
    return snapshot


def validate_library_profile(document, identity):
    snapshot = validate_restore_document(document)
    if snapshot["format"] != PROFILE_FORMAT or snapshot["selections"][0]["node"] != identity:
        raise ValueError("Klippee returned a different profile. Reload the library and choose again.")
    return snapshot


def validate_library_listing(data):
    if not isinstance(data, dict) or "expiresAt" not in data or data["expiresAt"] is not None and not isinstance(data["expiresAt"], str):
        raise ValueError("Klippee returned an invalid library response.")
    if data["expiresAt"] is not None:
        expires = datetime.fromisoformat(data["expiresAt"].replace("Z", "+00:00"))
        if expires.tzinfo is None or expires <= datetime.now(timezone.utc):
            raise ValueError("Browse access expired. Create a new code in Klippee.")
    library = data.get("library")
    if library is None:
        return {"id": "", "profiles": [], "expiresAt": data["expiresAt"], "uploadsEnabled": data.get("uploadsEnabled") is True}
    if not isinstance(library, dict) or not isinstance(library.get("id"), str) or not isinstance(library.get("profiles"), list) or len(library["profiles"]) > 768:
        raise ValueError("Klippee returned an invalid profile list.")
    profiles = []
    for profile in library["profiles"]:
        if not isinstance(profile, dict) or profile.get("kind") not in {"machine", "process", "filament"} or not isinstance(profile.get("name"), str) or not 1 <= len(profile["name"]) <= 512 or profile.get("id") != profile["kind"] + ":" + profile["name"]:
            raise ValueError("Klippee returned an invalid profile identity.")
        profiles.append({key: profile.get(key) for key in ("id", "kind", "name", "nozzle", "parent", "custom")})
    if len({p["id"] for p in profiles}) != len(profiles):
        raise ValueError("Klippee returned duplicate profiles.")
    return {"id": library["id"], "profiles": profiles, "expiresAt": data["expiresAt"], "uploadsEnabled": data.get("uploadsEnabled") is True}


try:
    import orca
except ImportError:
    orca = None

if orca is not None:
    PAGE = globals().get("_KLIPPEE_PAGE") or Path(__file__).with_name("klippee_plugin.html").read_text(encoding="utf-8")

    class KlippeeCapture(orca.pages.PagesPluginCapabilityBase):
        def __init__(self):
            super().__init__()
            self.results = Queue()
            self.busy = False
            self.preview = None
            self.pending_upload = None
            self.connection = None
            self.browse_connection = None
            self.connection_loaded = False
            self.disconnecting = False
            self.browse_library = None
            self.browse_requested = None
            self.restore_preview = None
            self.restore_baseline = None
            self.restore_result = None
            self.loaded = True
            self.stop_work = Event()
            self.worker = None
            self.lease = None
            self.steps = None
            self.view = None
            self.notice = ""
            self.progress = ""
            self.title = ""

        def restored_message(self):
            result = self.restore_result
            return {"command": "restored", "names": result["names"], "nodes": result["nodes"], "profile": result.get("profile", False), "kinds": result.get("kinds", [])}

        def read_restore_receipt(self):
            path = Path(orca.host.plugin.storage()) / "latest-restore.json"
            if not path.is_file() or path.stat().st_size > 2_000_000:
                raise ValueError("Restore a setup first, then check your selected presets.")
            receipt = json.loads(path.read_text(encoding="utf-8"))
            snapshot = validate_restore({"snapshot": receipt["snapshot"]})
            snapshot, _ = sanitize_capture(snapshot)
            stages, expected = plan_import(snapshot, receipt["bundle_id"], friendly=True)
            graph = import_graph(stages)
            self.restore_result = {"names": [key.split(":", 1)[1] for key in expected], "nodes": len(graph),
                                   "graph": graph, "expected": expected, "ancestors": saved_expectations(snapshot, graph),
                                   "profile": snapshot.get("format") == PROFILE_FORMAT, "kinds": [key.split(":", 1)[0] for key in expected]}

        def get_name(self):
            return "Klippee"

        def get_ui(self):
            return PAGE

        def publish(self, message):
            if not self.loaded:
                return
            if message["command"] == "error":
                self.notice = message["error"]
            elif message["command"] == "working":
                self.progress = message["text"]
                self.notice = ""
            else:
                self.view = message
                self.notice = ""
            self.post_message(message)

        def on_unload(self):
            self.loaded = False
            self.stop_work.set()
            if self.lease is not None:
                self.lease.cancel()
            self.lease = None
            self.worker = None
            if self.steps is not None:
                self.steps.close()
            self.steps = None
            self.busy = False
            self.pending_upload = None
            self.preview = self.connection = self.restore_preview = self.restore_baseline = None
            self.view = None
            self.browse_connection = self.browse_library = self.browse_requested = None
            self.restore_result = None
            self.restore_namespace = ""
            self.title = ""
            while not self.results.empty():
                try:
                    self.results.get_nowait()
                except Empty:
                    break

        def on_load(self):
            self.connection_loaded = False
            self.loaded = True
            self.stop_work = Event()

        def start_work(self, function, command):
            stop = self.stop_work = Event()
            queue = self.results
            self.busy = True
            def work():
                try:
                    data = function()
                    result = {"command": command, "data": data}
                except DisconnectedError as error:
                    result = {"command": "error", "error": str(error), "disconnected": True}
                except ValueError as error:
                    result = {"command": "error", "error": str(error)}
                except Exception:
                    result = {"command": "error", "error": "Operation failed. Check Orca's plugin permissions and retry."}
                result["_job"] = stop
                if not stop.is_set():
                    queue.put(result)
            self.worker = Thread(target=work, daemon=True)
            try:
                self.worker.start()
            except Exception:
                self.busy = False
                raise

        def start_request(self, origin, token, path, payload, command):
            request = make_request(origin, token, path, payload)
            # Orca's audit context is thread-local. Emit the standard urllib
            # audit event HERE, in the host callback, before any worker/DNS/I/O.
            # A native PermissionError aborts the action before a thread exists.
            sys.audit("urllib.Request", request.full_url, request.data, dict(request.headers), request.get_method())
            self.lease = RequestLease()
            lease = self.lease
            self.start_work(lambda: send_request(request, lease), command)

        def finish_restore(self, result):
            self.restore_result = result
            storage = Path(orca.host.plugin.storage())
            receipt = storage / "latest-restore.json"
            temporary = receipt.with_suffix(".tmp")
            temporary.write_text(json.dumps({"snapshot": self.restore_preview, "bundle_id": result["bundle_id"]}), encoding="utf-8")
            temporary.replace(receipt)
            (storage / "pending-restore.json").unlink(missing_ok=True)
            self.restore_preview = self.restore_baseline = None
            return self.restored_message()

        def check_steps(self):
            if self.restore_result is None:
                self.read_restore_receipt()
            result = self.restore_result
            selected = capture(orca.host.preset_bundle())
            names = [selected["nodes"][item["node"]]["name"] for item in selected["selections"]]
            failures = []
            for expected in (result["expected"], result["ancestors"]):
                for identity, settings in expected.items():
                    bundle = orca.host.preset_bundle()
                    failures += verify(bundle, {identity: settings}) + verify_graph(bundle, {identity: result["graph"][identity]})
                    del bundle
                    yield "Checking selected settings and inheritance…"
            if result.get("profile"):
                if capture(orca.host.preset_bundle()) != selected:
                    failures.append({"error": "Selection changed during verification"})
                if failures:
                    raise ValueError("Restored profile settings or inheritance no longer match the saved copy.")
                return {"command": "profile_verified", "nodes": result["nodes"]}
            for item, expected in zip(selected["selections"], result["expected"].values()):
                if any(canonical_value(key, item["effective"].get(key)) != canonical_value(key, expected.get(key))
                       for key in comparison_keys(item["effective"], expected)):
                    failures.append({"error": "Selected effective settings differ"})
            if capture(orca.host.preset_bundle()) != selected:
                failures.append({"error": "Selection changed during verification"})
            if names != result["names"] or failures:
                return {**self.restored_message(), "notice": "Select the printer, process and every filament slot listed below, then check again. Any current edits must match the restored copy."}
            return {"command": "restore_verified", "slots": len(names) - 2, "nodes": result["nodes"]}

        def advance(self):
            if self.steps is not None:
                try:
                    self.publish({"command": "working", "text": next(self.steps)})
                except StopIteration as done:
                    self.steps = None
                    self.busy = False
                    self.publish(self.finish_restore(done.value) if self.step_kind == "restore" else done.value)
                return
            while True:
                try:
                    result = self.results.get_nowait()
                except Empty:
                    return
                if result.pop("_job", self.stop_work) is self.stop_work:
                    break
            self.worker = None
            self.lease = None
            self.busy = False
            command = result["command"]
            if command == "upload_authorized":
                origin, token, scope = self.pending_upload
                self.pending_upload = None
                if result["data"].get("scope") != scope:
                    raise ValueError("Klippee returned a different upload review. Review again.")
                self.connection = (origin, token)
                if scope == "setup":
                    self.preview = sanitize_capture(capture(orca.host.preset_bundle()))
                command = "connected"
                result["command"] = command
            if self.disconnecting:
                self.disconnecting = False
                if command == "error":
                    result.update(disconnected=True, error="Disconnected on this computer. Klippee could not confirm server revocation; disconnect this installation in Klippee when online.")
            if result.get("disconnected"):
                saved_connection_path().unlink(missing_ok=True)
                self.browse_connection = self.browse_library = None
            if command == "device_paired":
                if result["data"].get("connected") is not True:
                    raise ValueError("Klippee did not confirm this connection. Connect again.")
                self.start_request(*self.browse_connection, "/api/orca/restore/library", {}, "library_listed")
                self.publish({"command": "working", "text": "Connected. Loading your library…"})
                return
            elif command == "device_disconnected":
                result = {"command": "cancelled", "notice": "Disconnected from Klippee. Saved profiles are kept."}
            elif command == "library_listed":
                self.browse_library = validate_library_listing(result["data"])
                result = {"command": "library_listed", "library": self.browse_library, "origin": self.browse_connection[0]}
            elif command == "profile_downloaded":
                document = result["data"]
                identity = self.browse_requested
                self.start_work(lambda: validate_library_profile(document, identity), "restore_review_ready")
                self.publish({"command": "working", "text": "Validating the saved profile and its full inheritance…"})
                return
            elif command == "restore_review_ready":
                self.restore_preview = result["data"]
                result = {"command": "restore_review", "selections": selection_summary(self.restore_preview),
                          "nodes": len(self.restore_preview["nodes"]), "omittedKeys": [],
                          "profile": self.restore_preview.get("format") == PROFILE_FORMAT}
            elif command == "restore_planned":
                plan = result["data"]
                self.restore_namespace = plan["bundle_id"]
                storage = Path(orca.host.plugin.storage())
                (storage / "pending-restore.json").write_text(json.dumps({"bundle_id": plan["bundle_id"]}), encoding="utf-8")
                self.steps = restore_steps(plan, self.restore_user, self.restore_baseline, orca.host.preset_bundle, orca.host.preset.bundles.reload_local)
                self.step_kind = "restore"
                self.busy = True
                self.publish({"command": "working", "text": "Restoring preset copies…"})
                return
            elif command == "connected":
                library = result["data"].get("scope") == "library"
                if library:
                    self.preview = sanitize_capture(capture(orca.host.preset_bundle(), library=True))
                    profiles = self.preview[0]["profiles"]
                    result["profiles"] = [{**profile, "kind": self.preview[0]["nodes"][profile["node"]]["kind"],
                                           "name": self.preview[0]["nodes"][profile["node"]]["name"]} for profile in profiles]
                current = self.preview[0]["current"] if library else self.preview[0]
                result.update(selections=selection_summary(current), omittedKeys=self.preview[1],
                              nodes=len(self.preview[0]["nodes"]), origin=self.connection[0])
                self.title = (current["selections"][0]["node"].split(":", 1)[1] + " / " + current["selections"][1]["node"].split(":", 1)[1])[:120]
            elif command == "saved":
                self.connection = self.preview = None
                self.title = ""
            self.publish(result)

        def on_message(self, message):
            try:
                if isinstance(message, str):
                    message = json.loads(message)
                if not isinstance(message, dict):
                    return
                command = message.get("command")
                if not self.loaded:
                    return
                if command in {"poll", "ready"}:
                    self.advance()
                    if command == "ready":
                        if not self.connection_loaded:
                            self.connection_loaded = True
                            if not self.busy and not self.browse_connection:
                                self.browse_connection = load_connection()
                                if self.browse_connection:
                                    self.start_request(*self.browse_connection, "/api/orca/restore/library", {}, "library_listed")
                        pending = Path(orca.host.plugin.storage()) / "pending-restore.json"
                        if pending.is_file() and self.steps is None and not self.busy:
                            self.notice = "An earlier restore was interrupted. Unverified copies may remain; restore the saved file again before using new copies."
                        self.post_message({"command": "state", "busy": self.busy, "view": self.view,
                                           "notice": self.notice, "progress": self.progress, "title": self.title,
                                           "library": self.browse_library or ({"id": "", "profiles": [], "expiresAt": None} if self.browse_connection else None), "browseOrigin": self.browse_connection[0] if self.browse_connection else ""})
                    return
                if command == "set_title":
                    title = message.get("title")
                    if isinstance(title, str) and len(title) <= 120:
                        self.title = title
                    return
                if command == "disconnect_library":
                    connection = self.browse_connection or load_connection()
                    # Stop active work and erase local access even when offline.
                    self.on_unload()
                    self.loaded = True
                    self.stop_work = Event()
                    self.connection_loaded = True
                    saved_connection_path().unlink(missing_ok=True)
                    if connection and connection[1].startswith("klorcadevice_"):
                        self.disconnecting = True
                        self.publish({"command": "cancelled", "notice": "Disconnected on this computer. Disconnect this installation in Klippee too if the server cannot be reached."})
                        self.start_request(*connection, "/api/orca/restore/disconnect", {}, "device_disconnected")
                        self.publish({"command": "working", "text": "Disconnecting… If offline, also disconnect this Orca installation in Klippee."})
                    else:
                        self.publish({"command": "cancelled", "notice": "Disconnected locally. Cancel the old browse code in Klippee to revoke it immediately."})
                    return
                if command == "cancel":
                    namespace = getattr(self, "restore_namespace", "")
                    saved_browse, saved_library = self.browse_connection, self.browse_library
                    self.on_unload()
                    self.loaded = True
                    self.stop_work = Event()
                    self.browse_connection, self.browse_library = saved_browse, saved_library
                    self.publish({"command": "cancelled", "library": saved_library, "origin": saved_browse[0] if saved_browse else "", "notice": ("Restore stopped. Unverified copies may remain under " + namespace + "; do not use them.") if namespace else "Cancelled locally. Your saved connection is kept. An upload already sent may still finish; reload Klippee to check." if saved_browse else "Cancelled locally. A save already sent may still finish; reload saved copies in Klippee."})
                    return
                if self.busy:
                    return
                if command in {"browse_library", "reload_library"}:
                    self.restore_preview = None
                    if command == "browse_library":
                        self.browse_library = None
                        origin, code = parse_connection(message.get("code"))
                        # Persist before sending so a lost response cannot lose a
                        # successfully paired credential. Never persist the code.
                        token = "klorcadevice_" + secrets.token_urlsafe(32)
                        store_connection(origin, token)
                        self.browse_connection = (origin, token)
                        self.connection_loaded = True
                        self.start_request(origin, code, "/api/orca/restore/pair", {"token": token}, "device_paired")
                        self.publish({"command": "working", "text": "Connecting this Orca installation to Klippee…"})
                        return
                    if not self.browse_connection:
                        self.browse_connection = load_connection()
                    if not self.browse_connection:
                        raise ValueError("Paste a Browse in Orca code from Klippee first.")
                    self.start_request(*self.browse_connection, "/api/orca/restore/library", {}, "library_listed")
                    self.publish({"command": "working", "text": "Loading your Klippee library…"})
                elif command in {"review_saved_library", "review_saved_setup"}:
                    connection = self.browse_connection or load_connection()
                    if not connection or not connection[1].startswith("klorcadevice_"):
                        raise ValueError("Connect this Orca installation to Klippee first.")
                    self.browse_connection = connection
                    self.preview = self.connection = self.restore_preview = None
                    self.view = None
                    scope = "library" if command == "review_saved_library" else "setup"
                    token = "klorca_" + secrets.token_urlsafe(32)
                    self.pending_upload = (connection[0], token, scope)
                    self.start_request(*connection, "/api/orca/device/upload-connection", {"id": str(uuid.uuid4()), "token": token, "scope": scope}, "upload_authorized")
                    self.publish({"command": "working", "text": "Preparing your profile import review…" if scope == "library" else "Preparing your setup review…"})
                elif command == "review_library_profile":
                    library = self.browse_library
                    identity = message.get("profileId")
                    if not self.browse_connection or not library or not any(p["id"] == identity for p in library["profiles"]):
                        raise ValueError("Load the library and choose a profile first.")
                    if library["expiresAt"] is not None and datetime.fromisoformat(library["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                        self.browse_connection = self.browse_library = None
                        raise ValueError("Browse access expired. Create a new code in Klippee.")
                    self.restore_preview = None
                    self.browse_requested = identity
                    self.restore_baseline = capture(orca.host.preset_bundle())
                    self.start_request(*self.browse_connection, "/api/orca/restore/profile", {"profileId": identity, "importId": library["id"]}, "profile_downloaded")
                    self.publish({"command": "working", "text": "Reading the saved profile and its ancestors…"})
                elif command == "review_restore":
                    self.view = None
                    self.restore_preview = None
                    self.preview = None
                    self.connection = None
                    text = message.get("text")
                    if not isinstance(text, str) or len(text.encode("utf-8")) > 600_000:
                        raise ValueError("Choose a Klippee profile or setup export smaller than 600 KB.")
                    self.restore_baseline = capture(orca.host.preset_bundle())
                    self.start_work(lambda: validate_restore_document(json.loads(text)), "restore_review_ready")
                    self.publish({"command": "working", "text": "Validating saved setup…"})
                elif command == "restore" and self.restore_preview:
                    bundle = orca.host.preset_bundle()
                    if capture(bundle) != self.restore_baseline:
                        self.restore_preview = None
                        raise ValueError("Your current setup changed. Review the saved profile or setup again before restoring.")
                    self.restore_user = restore_user_directory(bundle, orca.host.plugin.storage())
                    del bundle
                    snapshot = self.restore_preview
                    self.start_work(lambda: prepare_restore(snapshot), "restore_planned")
                    self.publish({"command": "working", "text": "Preparing restored copies…"})
                elif command == "check_restore":
                    self.steps = self.check_steps()
                    self.step_kind = "check"
                    self.busy = True
                    self.publish({"command": "working", "text": "Checking restored setup…"})
                elif command == "review":
                    self.view = None
                    self.connection = None
                    self.preview = None
                    connection = parse_connection(message.get("code"))
                    snapshot = capture(orca.host.preset_bundle())
                    self.preview = sanitize_capture(snapshot)
                    self.connection = connection
                    self.start_request(*connection, "/api/orca/capture/context", {}, "connected")
                elif command == "save" and self.preview and self.connection:
                    library = self.preview[0].get("format") == "klippee-orca-library/v1"
                    current = sanitize_capture(capture(orca.host.preset_bundle(), library=library))
                    if current != self.preview:
                        self.preview = None
                        raise ValueError("The setup changed after review. Review it again before saving.")
                    title = message.get("title")
                    if not isinstance(title, str) or not title.strip() or len(title) > 120:
                        raise ValueError("Give this setup a name (up to 120 characters).")
                    info = orca.host.app_info()
                    self.start_request(*self.connection, "/api/orca/library" if library else "/api/orca/capture", {
                        **({"library": self.preview[0]} if library else {"snapshot": self.preview[0]}),
                        "title": title.strip(), "omittedKeys": self.preview[1],
                        "hostVersion": info["version"], "hostBuild": info["build"],
                    }, "saved")
            except PermissionError:
                self.busy = False
                self.steps = None
                if self.disconnecting:
                    self.disconnecting = False
                    self.publish({"command": "error", "disconnected": True, "error": "Disconnected on this computer. Orca denied the server revocation request; disconnect this installation in Klippee too."})
                else:
                    self.publish({"command": "error", "error": "Orca denied permission. No new network request was started. Check the requested access before retrying."})
            except ValueError as error:
                self.busy = False
                self.steps = None
                self.publish({"command": "error", "error": str(error)})
            except Exception:
                self.busy = False
                self.steps = None
                self.publish({"command": "error", "error": "Could not complete the setup action. Check the file and Orca's plugin permissions, then retry."})

    @orca.plugin
    class KlippeePlugin(orca.base):
        def register_capabilities(self):
            orca.register_capability(KlippeeCapture)
