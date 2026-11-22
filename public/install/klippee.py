#!/usr/bin/env python3
"""Klippee's dependency-light config sync client.

The client runs on printer hosts and desktop computers using only Python's
standard library plus curl. Keeping the sync and safety logic here avoids
generating and executing shell programs at runtime.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import difflib
import glob
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import stat
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


CLI_VERSION = "2026.10.08"
MAX_CLI_BYTES = 2_000_000
OFFICIAL_UPGRADE_BASE_URL = "https://klippee.xyz"
WORKSPACE_IGNORE_CONTENT = "# Klippee local state contains sync credentials.\n*\n"
MAX_FILES = 64
MAX_FILE_BYTES = 256_000
MAX_DIAGNOSTIC_SOURCE_BYTES = 64 * 1024 * 1024
MAX_DIAGNOSTIC_SUPPORT_LOG_BYTES = 8 * 1024 * 1024
MAX_DIAGNOSTIC_COMMAND_BYTES = 2 * 1024 * 1024
MAX_DIAGNOSTIC_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_DIAGNOSTIC_UPLOAD_BYTES = 16 * 1024 * 1024
DIAGNOSTIC_BUNDLE_VERSION = 2
LOCAL_VARIABLES_NAME = "klippee_variables.cfg"
VARIABLE_ENTRY_PREFIX = "# KLIPPEE_VARIABLE "
VARIABLES_FILE_HEADER = (
    "# Klippee local variable values. Edit the entries below.\n"
    "# Format: # KLIPPEE_VARIABLE name=value\n"
    "# This file stays on this computer and is never included by klippee capture.\n"
    "# Every entry is a comment so broad Klipper include patterns remain safe.\n"
)
SENSITIVE_NAMES = {
    "auth.cfg",
    "authorization.cfg",
    "credentials.cfg",
    "credential.cfg",
    LOCAL_VARIABLES_NAME,
    "mooncord.cfg",
    "moonraker.cfg",
    "mobileraker.cfg",
    "password.cfg",
    "passwords.cfg",
    "saved_variables.cfg",
    "secret.cfg",
    "secrets.cfg",
    "telegram.cfg",
    "token.cfg",
    "tokens.cfg",
}
SENSITIVE_STEM = re.compile(
    r"(?:^|[-_])(auth|credentials?|passwords?|secrets?|tokens?)(?:[-_.]|$)"
)
SAVE_CONFIG_SNAPSHOT = re.compile(r"^printer-[0-9]+_[0-9]+\.cfg$")
SAVE_CONFIG_MARKER = re.compile(r"^#\*#.*\bSAVE_CONFIG\b", re.IGNORECASE)
SAVE_CONFIG_SECTION = re.compile(r"^#\*#\s*\[([^\]\r\n]+)\]\s*$")
SAVE_CONFIG_SEPARATOR = re.compile(r"^#\*#\s*$")
VOLATILE_SAVE_CONFIG_SECTION = re.compile(r"^(?:beacon model|bed_mesh)\s+\S", re.IGNORECASE)
INCLUDE_LINE = re.compile(r"^\s*\[include\s+(.+?)\]\s*(?:#.*)?$", re.IGNORECASE)
VARIABLE_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
VARIABLE_PLACEHOLDER = re.compile(r"\$\{KLIPPEE:([a-z][a-z0-9_]*)\}")
CLI_VERSION_ASSIGNMENT = re.compile(r'^CLI_VERSION\s*=\s*["\']([^"\']+)["\']\s*$', re.MULTILINE)
CLI_SOURCE_MARKER = "Klippee's dependency-light config sync client."
MOONRAKER_AGENT_METHODS = {
    "klippee_apply": ("apply", "--yes"),
    "klippee_capture": ("capture", "--note", "Captured from Mainsail/Fluidd"),
    "klippee_check": ("check",),
    "klippee_query_box_reset_reason": ("query-box-reset-reason",),
    "klippee_upload_diagnostics": ("upload-diagnostics",),
    # Compatibility for agents installed before the apply/capture/check rename.
    # Keep these at the RPC boundary only; generated macros use the current names.
    "klippee_pull": ("apply", "--if-clean"),
    "klippee_push": ("capture", "--note", "Captured from Mainsail/Fluidd"),
    "klippee_status": ("check",),
}
MOONRAKER_OPERATION_STATUS_METHOD = "klippee_operation_status"
MOONRAKER_KLIPPER_REMOTE_METHODS = tuple(MOONRAKER_AGENT_METHODS)
MOONRAKER_MACRO_MARKER = "# Managed by klippee install-moonraker."
MOONRAKER_AGENT_UNIT_NAME = "klippee-moonraker.service"
MOONRAKER_AGENT_UNIT_MARKER = "Description=Klippee Moonraker integration agent"
MOONRAKER_CONFIG_MUTATION_STATES = frozenset({"standby", "complete", "error", "cancelled"})
ETX = b"\x03"
USB_SERIAL_TTY = re.compile(r"^tty(?:ACM|USB)[0-9]{1,4}$")
USB_TOPOLOGY_PATH = re.compile(r"^[0-9]+-[0-9]+(?:\.[0-9]+)*$")
QIDI_BOX_BY_ID = re.compile(
    r"^usb-Klipper_QIDI_BOX_V1_1\.1\.1_([0-9A-F]{24})(?:-if00)?$"
)
QIDI_BOX_RESET_REASONS = frozenset({
    "PowerOn",
    "Unknown",
    "LowPower",
    "WindowWatchdog",
    "Software",
    "IndependentWatchdog",
    "NRST_Pin",
})
QIDI_BOX_FIRMWARE_VERSION = "KLP_MCU_MKS_V1_1.1.1"
QIDI_BOX_FIRMWARE_MCU = "stm32f401xc"
QIDI_BOX_DICTIONARY_SHA256 = "8ae1cedaf7648c75e300ea926de603acf8f48be4b37146b4e677eec7ced62841"
QIDI_BOX_QUERY_COMMAND = "reset_reason_get oid=%c"
QIDI_BOX_QUERY_RESPONSE = "reset_reason_return oid=%c reason=%s"
QIDI_BOX_QUERY_OID = 0xA5
QIDI_BOX_DEBUG_READ_COMMAND = "debug_read order=%c addr=%u"
QIDI_BOX_DEBUG_RESULT_RESPONSE = "debug_result val=%u"
QIDI_BOX_RCC_CSR_ADDRESS = 0x40023874
QIDI_BOX_RCC_CSR_ORDER = 2
QIDI_BOX_RESET_FLAG_MASKS = (
    ("LowPower", 0x80000000),
    ("WindowWatchdog", 0x40000000),
    ("IndependentWatchdog", 0x20000000),
    ("Software", 0x10000000),
    ("PowerOn", 0x08000000),
    ("NRST_Pin", 0x04000000),
    ("Brownout", 0x02000000),
)
QIDI_BOX_QUERY_SCHEMA = "klippee-box-reset-reason/v2"
QIDI_BOX_QUERY_CAVEAT = (
    "RCC_CSR reset flags are sticky until RMVF is cleared; this read-only query "
    "does not clear them and they may predate the incident."
)
QIDI_BOX_BOOLEAN_DIAGNOSTIC_VARIABLES = frozenset({
    "auto_init_detect",
    "auto_read_rfid",
    "auto_reload_detect",
    "enable_box",
    "is_tool_change",
    "qidi_box_auto_insert",
})
QIDI_BOX_INTEGER_DIAGNOSTIC_VARIABLES = frozenset({
    "box_count",
    "extrude_state",
    "load_retry_num",
})
QIDI_BOX_SLOT_DIAGNOSTIC_VARIABLE = re.compile(r"^slot(?:1[0-5]|[0-9])$")
QIDI_BOX_SLOT_NAME = re.compile(r"^slot(?:-1|1[0-5]|[0-9])$")
QIDI_BOX_RETRY_STEP = re.compile(r"^QDE_[0-9]{3}_[0-9]{3}_[0-9]{2}$")
# The result builder and the public-result validator must agree on these
# contract, safety, and precondition claims; a one-sided edit would make every
# query fail closed. Keep them defined exactly once.
QIDI_BOX_QUERY_CONTRACT = {
    "rcc_csr": {
        "command": QIDI_BOX_DEBUG_READ_COMMAND,
        "response": QIDI_BOX_DEBUG_RESULT_RESPONSE,
        "address": f"0x{QIDI_BOX_RCC_CSR_ADDRESS:08X}",
        "order": QIDI_BOX_RCC_CSR_ORDER,
    },
    "reset_reason": {
        "command": QIDI_BOX_QUERY_COMMAND,
        "response": QIDI_BOX_QUERY_RESPONSE,
        "oid": QIDI_BOX_QUERY_OID,
    },
}
QIDI_BOX_TRANSPORT_PRECONDITIONS = {
    "endpoint_unowned": True,
    "exclusive_open": True,
}
QIDI_BOX_PRECONDITIONS = {
    "fresh_klippy_state": "shutdown",
    "endpoint_unowned": True,
    "exclusive_open": True,
}
QIDI_BOX_SAFETY_CLAIMS = {
    "read_only": True,
    "reset_requested": False,
    "flags_cleared": False,
    "config_changed": False,
    "klipper_action": "none",
    "may_be_stale": True,
}
QIDI_BOX_FIRMWARE_IDENTITY = {
    "version": QIDI_BOX_FIRMWARE_VERSION,
    "mcu": QIDI_BOX_FIRMWARE_MCU,
}
QIDI_BOX_TRANSPORT_BOOTSTRAP = (
    "import json,runpy,sys;"
    "namespace=runpy.run_path(sys.argv[1],run_name='klippee_box_query');"
    "result=namespace['_query_qidi_box_reset_reason_transport'](sys.argv[2],sys.argv[3]);"
    "print(json.dumps(result,separators=(',',':'),sort_keys=True))"
)


class CliError(Exception):
    """An expected user-facing CLI error."""


class ApiError(CliError):
    """A structured non-success response from the Klippee API."""

    def __init__(self, status: int, payload: Any, message: str):
        super().__init__(message)
        self.status = status
        self.payload = payload


def unlink_if_exists(path: Path) -> None:
    """Remove a temporary file without requiring pathlib's Python 3.8 API."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def path_is_link(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(is_junction and is_junction())


def write_atomic_bytes(target: Path, content: bytes, mode: int | None = None) -> None:
    """Replace ``target`` atomically via a same-directory temporary file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.klippee-{os.getpid()}")
    try:
        temporary.write_bytes(content)
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        unlink_if_exists(temporary)


def write_atomic_text(target: Path, content: str, mode: int | None = None) -> None:
    write_atomic_bytes(target, content.encode("utf-8"), mode)


@dataclass(frozen=True)
class Config:
    base_url: str
    repository_id: str
    token: str
    config_dir: Path
    client_mode: str = "printer"


@dataclass(frozen=True)
class RemoteSnapshot:
    applied_version_number: int | None
    created_at: str
    files: list[dict[str, Any]]
    pending: bool
    rendered_names: set[str]
    revision: str
    source: str
    template_files: list[dict[str, Any]]
    version_id: str
    version_number: int


def home_dir() -> Path:
    return Path(os.environ.get("HOME") or Path.home()).expanduser()


def state_dir() -> Path:
    return Path(os.environ.get("KLIPPEE_STATE_DIR") or home_dir() / ".klippee").expanduser()


def config_json_path() -> Path:
    return state_dir() / "config.json"


def workspace_config_json_path(config_dir: Path) -> Path:
    return config_dir / ".klippee" / "config.json"


def active_config_json_path() -> Path:
    """Prefer the desktop workspace containing the current directory."""
    if os.environ.get("KLIPPEE_STATE_DIR"):
        return config_json_path()
    current = Path.cwd().resolve()
    for directory in (current,) + tuple(current.parents):
        candidate = workspace_config_json_path(directory)
        if candidate.is_file():
            return candidate
    return config_json_path()


def workspace_root_for_config(path: Path) -> Path | None:
    if os.environ.get("KLIPPEE_STATE_DIR"):
        return None
    current = Path.cwd().resolve()
    for directory in (current,) + tuple(current.parents):
        if workspace_config_json_path(directory) == path:
            return directory
    return None


def legacy_config_path() -> Path:
    return state_dir() / "config"


def normalize_client_mode(value: Any) -> str:
    mode = str(value or "printer").strip().lower()
    if mode not in {"desktop", "printer"}:
        raise CliError("client mode must be 'desktop' or 'printer'")
    return mode


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def eprint_cli_error(error: object) -> None:
    """Print an error to stderr with a ``klippee: `` prefix on every line."""
    for line in str(error).splitlines() or [""]:
        eprint(f"klippee: {line}")


def path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_program(name: str) -> str | None:
    """Resolve a system tool without Windows' implicit current-directory search."""
    if Path(name).name != name:
        return None
    current = Path.cwd().resolve()
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if os.name == "nt" and not Path(name).suffix:
        extensions = [
            extension
            for extension in os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
            if extension
        ]
    else:
        extensions = [""]
    for raw_entry in path_entries:
        expanded = os.path.expandvars(os.path.expanduser(raw_entry.strip().strip('"')))
        if not expanded:
            continue
        entry = Path(expanded)
        if not entry.is_absolute():
            continue
        lexical_entry = Path(os.path.abspath(str(entry)))
        try:
            resolved_entry = entry.resolve()
        except OSError:
            continue
        if len(current.parts) > 1 and (
            path_within(lexical_entry, current) or path_within(resolved_entry, current)
        ):
            continue
        for extension in extensions:
            candidate = resolved_entry / f"{name}{extension}"
            if candidate.is_file() and (os.name == "nt" or os.access(candidate, os.X_OK)):
                return str(candidate.resolve())
    return None


def require_program(name: str) -> str:
    executable = resolve_program(name)
    if executable is None:
        raise CliError(f"{name} is required")
    return executable


def normalize_api_base_url(value: str) -> str:
    base_url = value.rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise CliError("Klippee API URL must be an HTTP(S) origin without credentials, a query, or a fragment")
    return base_url


def validate_private_config_path(path: Path, workspace: Path | None = None) -> None:
    if path_is_link(path) or path_is_link(path.parent):
        raise CliError(f"refusing to load sync credentials from a linked path: {path}")
    nested_git = path.parent / ".git"
    if workspace is not None and (nested_git.exists() or path_is_link(nested_git)):
        raise CliError("refusing to load sync credentials from a nested .klippee Git repository")
    try:
        metadata = path.stat()
    except OSError as error:
        raise CliError(f"could not inspect sync credentials at {path}") from error
    if os.name != "nt":
        if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
            raise CliError(f"sync credentials must be owned by the current user: {path}")
        if metadata.st_mode & 0o077:
            raise CliError(f"sync credentials are not private; run chmod 600 {path}")


def parse_legacy_config(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, raw_value = line.split("=", 1)
        if name not in {
            "KLIPPEE_BASE_URL",
            "KLIPPEE_REPOSITORY_ID",
            "KLIPPEE_TOKEN",
            "KLIPPEE_CONFIG_DIR",
        }:
            continue
        try:
            parsed = shlex.split(raw_value, posix=True)
        except ValueError as error:
            raise CliError(f"invalid legacy config value for {name}: {error}") from error
        if len(parsed) != 1:
            raise CliError(f"invalid legacy config value for {name}")
        values[name] = parsed[0]
    return values


def load_config() -> Config:
    path = active_config_json_path()
    workspace = workspace_root_for_config(path)
    if path.is_file():
        validate_private_config_path(path, workspace)
        if workspace is not None:
            if git_tracks_workspace_config(workspace, path):
                raise CliError(
                    "refusing to load a sync token from a Git-tracked .klippee/config.json; "
                    "remove it from the index and rotate any token that was already committed"
                )
            if not git_ignores_workspace_config(workspace, path):
                raise CliError(
                    "refusing to load .klippee/config.json until Git ignores it; rerun klippee init --desktop"
                )
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise CliError(f"could not read {path}: {error}") from error
        values = {
            "KLIPPEE_BASE_URL": payload.get("base_url"),
            "KLIPPEE_REPOSITORY_ID": payload.get("repository_id"),
            "KLIPPEE_TOKEN": payload.get("token"),
            "KLIPPEE_CONFIG_DIR": payload.get("config_dir"),
        }
        client_mode = normalize_client_mode(payload.get("client_mode", "printer"))
    elif legacy_config_path().is_file():
        legacy_path = legacy_config_path()
        validate_private_config_path(legacy_path)
        values = parse_legacy_config(legacy_path)
        client_mode = "printer"
    else:
        raise CliError("not configured; run klippee init")

    missing = [name for name, value in values.items() if not isinstance(value, str) or not value]
    if missing:
        raise CliError(f"missing {', '.join(missing)}")
    configured_dir = Path(str(values["KLIPPEE_CONFIG_DIR"])).expanduser()
    if client_mode == "desktop":
        configured_dir = configured_dir.resolve()
    if workspace is not None:
        if client_mode != "desktop" or configured_dir != workspace.resolve():
            raise CliError("workspace .klippee/config.json must use desktop mode and point to that workspace")
    return Config(
        base_url=normalize_api_base_url(str(values["KLIPPEE_BASE_URL"])),
        repository_id=str(values["KLIPPEE_REPOSITORY_ID"]),
        token=str(values["KLIPPEE_TOKEN"]),
        config_dir=configured_dir,
        client_mode=client_mode,
    )


def write_config(
    base_url: str,
    repository_id: str,
    token: str,
    config_dir: str,
    client_mode: str = "printer",
) -> Config:
    if not repository_id:
        raise CliError("repository id is required")
    if not token:
        raise CliError("sync token is required")
    mode = normalize_client_mode(client_mode)
    target_dir = Path(config_dir).expanduser()
    if mode == "desktop":
        target_dir = target_dir.resolve()
    payload = {
        "base_url": normalize_api_base_url(base_url),
        "repository_id": repository_id,
        "token": token,
        "config_dir": str(target_dir),
        "client_mode": mode,
    }
    target = (
        workspace_config_json_path(target_dir)
        if mode == "desktop" and not os.environ.get("KLIPPEE_STATE_DIR")
        else config_json_path()
    )
    if mode == "desktop" and target == workspace_config_json_path(target_dir):
        if git_tracks_workspace_config(target_dir, target):
            raise CliError(
                "refusing to store a sync token in a Git-tracked .klippee/config.json; "
                "remove it from the index and rotate any token that was already committed"
            )
        ensure_workspace_state_ignored(target_dir, target.parent)
        if not git_ignores_workspace_config(target_dir, target):
            raise CliError("refusing to store .klippee/config.json because Git ignore status could not be verified")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
    write_atomic_text(target, json.dumps(payload, indent=2) + "\n", mode=0o600)
    return Config(payload["base_url"], repository_id, token, target_dir, mode)


def git_tracks_workspace_config(workspace: Path, target: Path) -> bool:
    """Return whether Git already tracks the workspace credential file."""
    git = resolve_program("git")
    if git is None or not workspace.is_dir():
        return False
    try:
        repository = subprocess.run(
            [git, "-C", str(workspace), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if repository.returncode != 0 or not repository.stdout.strip():
            return False
        root = Path(repository.stdout.strip()).resolve()
        nested_repository = subprocess.run(
            [git, "-C", str(target.parent), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if (
            nested_repository.returncode == 0
            and nested_repository.stdout.strip()
            and Path(nested_repository.stdout.strip()).resolve() != root
        ):
            return True
        try:
            relative = target.resolve().relative_to(root).as_posix()
        except ValueError:
            return False
        tracked = subprocess.run(
            [git, "-C", str(root), "ls-files", "--error-unmatch", "--", relative],
            text=True,
            capture_output=True,
            check=False,
        )
        return tracked.returncode == 0
    except OSError:
        return False


def workspace_has_git_metadata(workspace: Path) -> bool:
    for parent in (workspace,) + tuple(workspace.parents):
        try:
            (parent / ".git").lstat()
            return True
        except FileNotFoundError:
            continue
        except OSError:
            return True
    return False


def git_ignores_workspace_config(workspace: Path, target: Path) -> bool:
    git = resolve_program("git")
    if git is None:
        return not workspace_has_git_metadata(workspace)
    try:
        repository = subprocess.run(
            [git, "-C", str(workspace), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if repository.returncode != 0 or not repository.stdout.strip():
            return not workspace_has_git_metadata(workspace)
        root = Path(repository.stdout.strip()).resolve()
        relative = target.resolve().relative_to(root).as_posix()
        ignored = subprocess.run(
            [git, "-C", str(root), "check-ignore", "--quiet", "--no-index", "--", relative],
            capture_output=True,
            check=False,
        )
        return ignored.returncode == 0
    except (OSError, ValueError):
        return False


def ensure_workspace_state_ignored(workspace: Path, state_dir: Path) -> None:
    """Keep all workspace-local state ignored, including with an existing file."""
    if path_is_link(state_dir):
        raise CliError("refusing to store workspace credentials in a linked .klippee directory")
    nested_git = state_dir / ".git"
    if nested_git.exists() or path_is_link(nested_git):
        raise CliError("refusing to store workspace credentials in a nested .klippee Git repository")
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        state_dir.resolve().relative_to(workspace.resolve())
    except (OSError, ValueError) as error:
        raise CliError("could not create a private .klippee workspace directory") from error

    ignore = state_dir / ".gitignore"
    if ignore.is_symlink():
        raise CliError("refusing to update a linked .klippee/.gitignore file")
    try:
        existing = ignore.read_bytes() if ignore.exists() else b""
    except OSError as error:
        raise CliError("could not inspect .klippee/.gitignore") from error
    marker = WORKSPACE_IGNORE_CONTENT.encode("utf-8")
    if existing.replace(b"\r\n", b"\n").rstrip(b"\n").endswith(marker.rstrip(b"\n")):
        return
    updated = existing
    if updated and not updated.endswith((b"\n", b"\r")):
        updated += b"\n"
    updated += marker
    try:
        write_atomic_bytes(ignore, updated)
    except OSError as error:
        raise CliError("could not protect workspace credentials with .klippee/.gitignore") from error


def curl_authorization_config(token: str) -> str:
    """Pass the bearer token through curl's stdin config, not the process list."""
    if "\r" in token or "\n" in token:
        raise CliError("sync token contains an invalid line break")
    escaped = token.replace("\\", "\\\\").replace('"', '\\"')
    return f'header = "Authorization: Bearer {escaped}"\n'


def run_curl(
    url: str,
    *,
    method: str = "GET",
    headers: Iterable[str] = (),
    data_path: Path | None = None,
    token: str | None = None,
    max_bytes: int | None = None,
    failure_message: str | None = None,
) -> tuple[int, bytes]:
    """Run curl with the shared transport-hardening flags and return (status, body).

    ``--disable`` always comes first so user curl configuration files are
    ignored; the bearer token still travels over the explicit ``--config -``
    stdin channel, which curl reads after ``--disable``, keeping it off the
    process list.
    """
    curl = require_program("curl")
    request_protocol = f"={urllib.parse.urlparse(url).scheme}"
    response_handle = tempfile.NamedTemporaryFile(prefix="klippee-response-", delete=False)
    response_path = Path(response_handle.name)
    response_handle.close()
    command = [curl, "--disable"]
    stdin_config = ""
    if token is not None:
        command.extend(["--config", "-"])
        stdin_config = curl_authorization_config(token)
    command.extend([
        "--silent",
        "--show-error",
        "--proto",
        request_protocol,
        "--proto-redir",
        request_protocol,
        "--max-redirs",
        "0",
        "-o",
        str(response_path),
        "-w",
        "%{http_code}",
    ])
    if max_bytes is not None:
        command.extend(["--max-filesize", str(max_bytes)])
    if method != "GET":
        command.extend(["-X", method])
    for header in headers:
        command.extend(["-H", header])
    if data_path is not None:
        command.extend(["--data-binary", f"@{data_path}"])
    command.append(url)
    try:
        result = subprocess.run(
            command,
            input=stdin_config,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            prefix = failure_message or f"could not reach {url}"
            detail = result.stderr.strip()
            raise CliError(f"{prefix}{f': {detail}' if detail else ''}")
        try:
            status = int(result.stdout.strip()[-3:])
        except ValueError as error:
            raise CliError(f"invalid HTTP status returned for {url}") from error
        return status, response_path.read_bytes()
    finally:
        unlink_if_exists(response_path)


def api_call(
    config: Config,
    path: str,
    *,
    method: str = "GET",
    payload: Any | None = None,
    parse_json: bool = False,
) -> Any:
    url = f"{config.base_url}{path}"
    payload_path: Path | None = None
    try:
        headers: list[str] = []
        if payload is not None:
            payload_handle = tempfile.NamedTemporaryFile(
                mode="w",
                prefix="klippee-payload-",
                suffix=".json",
                encoding="utf-8",
                delete=False,
            )
            payload_path = Path(payload_handle.name)
            with payload_handle:
                json.dump(payload, payload_handle, separators=(",", ":"))
            headers.append("Content-Type: application/json")
        status, body = run_curl(
            url,
            method=method,
            headers=headers,
            data_path=payload_path,
            token=config.token,
        )
        raw = body.decode("utf-8", errors="replace")
        if not 200 <= status < 300:
            error_payload: Any = None
            try:
                error_payload = json.loads(raw)
            except json.JSONDecodeError:
                pass
            detail_lines = raw.splitlines()
            if isinstance(error_payload, dict) and isinstance(error_payload.get("error"), str):
                detail_lines = [str(error_payload["error"])]
            details = "\n".join(f"  {line}" for line in detail_lines)
            suffix = f"\n{details}" if details else ""
            raise ApiError(status, error_payload, f"server returned HTTP {status} for {url}{suffix}")
        if parse_json:
            try:
                return json.loads(raw)
            except json.JSONDecodeError as error:
                raise CliError(f"server returned invalid JSON for {url}") from error
        return raw
    finally:
        if payload_path is not None:
            unlink_if_exists(payload_path)


def valid_relative_path(relative: str) -> bool:
    path = PurePosixPath(relative.replace("\\", "/"))
    return not path.is_absolute() and bool(path.parts) and ".." not in path.parts


def safe_config_path(relative: str) -> bool:
    normalized = relative.replace("\\", "/")
    if not valid_relative_path(normalized) or not normalized.lower().endswith(".cfg"):
        return False
    parts = PurePosixPath(normalized.lower()).parts
    if any(part.startswith(".") for part in parts):
        return False
    basename = parts[-1]
    if basename in SENSITIVE_NAMES or SAVE_CONFIG_SNAPSHOT.fullmatch(basename):
        return False
    return SENSITIVE_STEM.search(basename) is None


def safe_capture_target(root: Path, relative: str) -> bool:
    """Reject sensitive config names anywhere in a captured file's link chain.

    External symlinked directories are supported for Klipper add-ons such as
    KAMP. Inspecting the link targets still lets those ordinary configs pass,
    while preventing a benign in-tree alias from hiding a secret or backup
    filename.
    """
    if not safe_config_path(relative):
        return False

    backup_directory_names = {"backup", "backups", "archive", "archives"}

    def safe_component(name: str) -> bool:
        if name in {"", ".", ".."}:
            return True
        normalized = name.lower()
        if normalized.startswith("."):
            return False
        if normalized in backup_directory_names:
            return False
        if SENSITIVE_STEM.search(normalized) or SAVE_CONFIG_SNAPSHOT.fullmatch(normalized):
            return False
        if normalized.endswith(".cfg") and not safe_config_path(normalized):
            return False
        return True

    pending = list(PurePosixPath(relative.replace("\\", "/")).parts)
    current = root.resolve()
    followed_links = 0
    while pending:
        part = pending.pop(0)
        if part in {"", "."}:
            continue
        if part == "..":
            current = current.parent
            continue
        if not safe_component(part):
            return False
        candidate = current / part
        if not path_is_link(candidate):
            current = candidate
            continue
        followed_links += 1
        if followed_links > 40:
            return False
        try:
            target_text = os.readlink(str(candidate))
        except OSError:
            return False
        target = Path(target_text)
        if any(not safe_component(component) for component in target.parts):
            return False
        if target.is_absolute():
            current = Path(target.anchor)
            pending = list(target.parts[1:]) + pending
        else:
            pending = list(target.parts) + pending
    try:
        resolved = (root / relative).resolve(strict=True)
        return resolved.is_file() and resolved.suffix.lower() == ".cfg" and safe_component(resolved.name)
    except OSError:
        return False


def config_path_collision_key(relative: str) -> str:
    return unicodedata.normalize("NFC", relative.replace("\\", "/")).casefold()


def all_config_files(root: Path) -> list[str]:
    if not root.is_dir():
        return []
    paths: list[str] = []
    for candidate in root.rglob("*.cfg"):
        if not candidate.is_file():
            continue
        if candidate.name.lower() == LOCAL_VARIABLES_NAME:
            continue
        relative = candidate.relative_to(root).as_posix()
        if ".klippee" in PurePosixPath(relative).parts:
            continue
        paths.append(relative)
    return sorted(set(paths))


def include_patterns(path: Path) -> Iterable[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    patterns = []
    for line in lines:
        match = INCLUDE_LINE.match(line)
        if match is not None:
            patterns.append(match.group(1).strip())
    return patterns


def referenced_config_files(root: Path) -> list[str] | None:
    root = root.resolve()
    entrypoint = root / "printer.cfg"
    if not entrypoint.is_file():
        return None
    queued = ["printer.cfg"]
    seen: set[str] = set()
    reached: set[str] = set()
    while queued:
        relative = queued.pop(0)
        if relative in seen:
            continue
        seen.add(relative)
        path = root / relative
        if not path.is_file():
            continue
        reached.add(relative)
        for pattern in include_patterns(path):
            search = str(path.parent / pattern)
            for match_name in sorted(glob.glob(search)):
                match_path = Path(match_name)
                if not match_path.is_file():
                    continue
                try:
                    # Keep the path as Klipper sees it inside the config tree.
                    # KAMP is commonly installed as an in-tree symlink to a
                    # checkout elsewhere on disk; resolving that symlink would
                    # incorrectly make a valid include look out-of-tree.
                    match_absolute = Path(os.path.abspath(str(match_path)))
                    found = match_absolute.relative_to(root).as_posix()
                except ValueError:
                    continue
                if valid_relative_path(found) and found not in seen:
                    queued.append(found)
    return sorted(reached)


def config_files(root: Path) -> list[str]:
    referenced = referenced_config_files(root)
    candidates = referenced if referenced is not None else all_config_files(root)
    return [relative for relative in candidates if safe_capture_target(root, relative)]


def rejected_config_files(root: Path) -> list[str]:
    referenced = referenced_config_files(root)
    candidates = referenced if referenced is not None else all_config_files(root)
    rejected_targets = {
        relative for relative in candidates if not safe_capture_target(root, relative)
    }
    return sorted((set(all_config_files(root)) - set(config_files(root))) | rejected_targets)


def file_role(relative: str) -> str:
    lower = relative.lower()
    if lower == "printer.cfg":
        return "main"
    if "macro" in lower:
        return "macro"
    if "moonraker" in lower:
        return "moonraker"
    return "include"


def file_checksum(path: Path) -> str:
    # Always use the stdlib digest: an external `cksum` dependency made the
    # baseline format depend on PATH contents, so a PATH change between runs
    # spuriously reported every file as locally changed.
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest}:{path.stat().st_size}"


def manifest_path(config: Config) -> Path:
    return config.config_dir / ".klippee" / "last-sync-files"


def sync_metadata_path(config: Config) -> Path:
    return config.config_dir / ".klippee" / "last-sync"


def read_sync_metadata(config: Config) -> dict[str, str]:
    target = sync_metadata_path(config)
    if not target.is_file():
        return {}
    values: dict[str, str] = {}
    for line in target.read_text(encoding="utf-8", errors="replace").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip():
            values[name.strip()] = value.strip()
    return values


def write_sync_metadata(config: Config, values: dict[str, Any]) -> None:
    normalized = {
        "schema": "1",
        "repository_id": config.repository_id,
        **{
            name: str(value).replace("\r", " ").replace("\n", " ")
            for name, value in values.items()
            if value is not None
        },
    }
    write_atomic_text(
        sync_metadata_path(config),
        "".join(f"{name}={value}\n" for name, value in normalized.items()),
    )


def write_sync_baseline(config: Config, relative_paths: Iterable[str] | None = None) -> None:
    candidates = config_files(config.config_dir) if relative_paths is None else sorted(set(relative_paths))
    lines = [
        f"{file_checksum(config.config_dir / relative)}|{relative}"
        for relative in candidates
        if safe_config_path(relative) and (config.config_dir / relative).is_file()
    ]
    write_atomic_text(manifest_path(config), "".join(f"{line}\n" for line in lines))


def read_manifest(config: Config) -> dict[str, str]:
    target = manifest_path(config)
    if not target.is_file():
        return {}
    values: dict[str, str] = {}
    for line in target.read_text(encoding="utf-8", errors="replace").splitlines():
        checksum, separator, relative = line.partition("|")
        if separator and valid_relative_path(relative):
            values[relative] = checksum
    return values


def local_changed_files(config: Config) -> list[str]:
    manifest = read_manifest(config)
    if manifest:
        current_files = set(config_files(config.config_dir))
        changed = [
            relative
            for relative, checksum in manifest.items()
            if not (config.config_dir / relative).is_file()
            or checksum != file_checksum(config.config_dir / relative)
        ]
        changed.extend(relative for relative in current_files if relative not in manifest)
        return sorted(set(changed))
    marker = sync_metadata_path(config)
    if not marker.is_file():
        return []
    marker_time = marker.stat().st_mtime
    return [
        relative
        for relative in all_config_files(config.config_dir)
        if (config.config_dir / relative).stat().st_mtime > marker_time
    ]


def has_valid_sync_baseline(config: Config) -> bool:
    metadata_target = sync_metadata_path(config)
    manifest_target = manifest_path(config)
    if (
        not metadata_target.is_file()
        or path_is_link(metadata_target)
        or not manifest_target.is_file()
        or path_is_link(manifest_target)
    ):
        return False
    try:
        metadata = read_sync_metadata(config)
        manifest_lines = [
            line
            for line in manifest_target.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.strip()
        ]
    except OSError:
        return False
    if (
        metadata.get("schema") != "1"
        or metadata.get("repository_id") != config.repository_id
        or not metadata.get("revision")
        or not manifest_lines
    ):
        return False
    seen: set[str] = set()
    for line in manifest_lines:
        checksum, separator, relative = line.partition("|")
        if (
            not checksum
            or not separator
            or not valid_relative_path(relative)
            or not safe_config_path(relative)
            or relative in seen
        ):
            return False
        seen.add(relative)
    return True


def require_clean_sync_baseline(config: Config) -> None:
    if not has_valid_sync_baseline(config):
        raise CliError(
            "apply --if-clean requires an existing valid sync baseline; "
            "run a reviewed 'klippee apply' or 'klippee capture' first"
        )
    changed = local_changed_files(config)
    if changed:
        detail = "\n".join(f"  - {relative}" for relative in changed)
        raise CliError(
            "apply --if-clean refused because local configuration changed since the last sync:\n"
            f"{detail}\n"
            "review with 'klippee check --diff', then choose apply or capture explicitly"
        )


def unique_backup_dir(config: Config) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = config.config_dir / ".klippee" / "backups" / f"manual-{stamp}"
    candidate = base
    suffix = 2
    while candidate.exists():
        candidate = base.with_name(f"{base.name}-{suffix}")
        suffix += 1
    candidate.mkdir(parents=True, exist_ok=False)
    return candidate


def backup_config_dir(config: Config) -> Path:
    backup = unique_backup_dir(config)
    tracked = set(read_manifest(config))
    tracked.update(config_files(config.config_dir))
    for relative in sorted(tracked):
        source = config.config_dir / relative
        if not source.is_file() or not safe_config_path(relative):
            continue
        destination = backup / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return backup


def cfg_files_under(root: Path) -> list[str]:
    return all_config_files(root)


def local_recovery_files(root: Path) -> list[str]:
    paths: list[str] = []
    for current_name, directory_names, file_names in os.walk(str(root), followlinks=False):
        current = Path(current_name)
        for directory_name in list(directory_names):
            directory = current / directory_name
            if path_is_link(directory):
                relative = directory.relative_to(root).as_posix()
                raise CliError(f"refusing to restore linked recovery file: {relative}")
        for file_name in file_names:
            candidate = current / file_name
            if not file_name.lower().endswith(".cfg") or file_name.lower() == LOCAL_VARIABLES_NAME:
                continue
            relative = candidate.relative_to(root).as_posix()
            if path_is_link(candidate):
                raise CliError(f"refusing to restore linked recovery file: {relative}")
            if ".klippee" not in PurePosixPath(relative).parts:
                paths.append(relative)
    return sorted(set(paths))


def restore_changes(
    config: Config,
    source_files: list[tuple[str, Path, Path]],
) -> tuple[list[str], set[str]]:
    changes: list[str] = []
    changed_names: set[str] = set()
    source_names = {relative for relative, _source, _destination in source_files}
    for relative, source_file, destination in source_files:
        if not destination.is_file():
            changes.append(f"  add {relative}")
            changed_names.add(relative)
        elif source_file.read_bytes() != destination.read_bytes():
            changes.append(f"  update {relative}")
            changed_names.add(relative)
    for relative in config_files(config.config_dir):
        if relative not in source_names:
            changes.append(f"  keep local-only {relative}")
    return changes, changed_names


def desired_configuration_path(config: Config) -> str:
    return f"/api/sync/repos/{config.repository_id}/pull"


def variable_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return None


def parse_variable_entry(raw_line: str) -> tuple[str, str] | None:
    line = raw_line.strip()
    if line.startswith(VARIABLE_ENTRY_PREFIX):
        line = line[len(VARIABLE_ENTRY_PREFIX):].strip()
    elif not line or line.startswith("#"):
        return None
    name, separator, value = line.partition("=")
    if not separator or VARIABLE_NAME.fullmatch(name) is None:
        return None
    return name, value


def local_variable_values(config: Config) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in read_variables(variables_path(config)):
        entry = parse_variable_entry(raw_line)
        if entry is not None:
            name, value = entry
            values[name] = value
    return values


def render_snapshot_variables(
    files: list[dict[str, Any]],
    values: dict[str, str],
) -> tuple[list[dict[str, Any]], set[str]]:
    rendered_names: set[str] = set()
    unresolved_names: set[str] = set()
    rendered_files: list[dict[str, Any]] = []

    for file in files:
        content = str(file["content"])

        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            value = values.get(name)
            if value is None or value == "":
                unresolved_names.add(name)
                return match.group(0)
            rendered_names.add(name)
            return value

        rendered_files.append({**file, "content": VARIABLE_PLACEHOLDER.sub(replace, content)})

    if unresolved_names:
        names = ", ".join(sorted(unresolved_names))
        raise CliError(
            f"cannot render config; missing printer values for: {names}\n"
            "set each missing value with 'klippee variables set <name> <value>' and retry"
        )
    return rendered_files, rendered_names


def variable_templates_path(config: Config) -> Path:
    return config.config_dir / ".klippee" / "variable-templates.json"


def write_variable_templates(
    config: Config,
    template_files: list[dict[str, Any]],
    rendered_files: list[dict[str, Any]],
) -> None:
    rendered_by_path = {str(file["path"]): str(file["content"]) for file in rendered_files}
    templates = {}
    for file in template_files:
        relative = str(file["path"])
        template = str(file["content"])
        rendered = rendered_by_path.get(relative)
        if rendered is not None and VARIABLE_PLACEHOLDER.search(template):
            templates[relative] = {"rendered": rendered, "template": template}
    target = variable_templates_path(config)
    if not templates:
        unlink_if_exists(target)
        return
    write_atomic_text(
        target,
        json.dumps({"files": templates}, separators=(",", ":")) + "\n",
        mode=0o600,
    )


def read_variable_templates(config: Config) -> dict[str, tuple[str, str]]:
    target = variable_templates_path(config)
    if not target.is_file():
        return {}
    maximum_size = (MAX_FILES * MAX_FILE_BYTES * 2) + 1_000_000
    if target.stat().st_size > maximum_size:
        return {}
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, dict):
        return {}
    templates: dict[str, tuple[str, str]] = {}
    for relative, entry in files.items():
        if not isinstance(relative, str) or not safe_config_path(relative) or not isinstance(entry, dict):
            continue
        template = entry.get("template")
        rendered = entry.get("rendered")
        if isinstance(template, str) and isinstance(rendered, str):
            templates[relative] = (template, rendered)
    return templates


def restore_variable_placeholders(
    relative: str,
    current: str,
    templates: dict[str, tuple[str, str]],
) -> str:
    state = templates.get(relative)
    if state is None:
        return current
    template, rendered = state
    template_lines = template.splitlines(keepends=True)
    rendered_lines = rendered.splitlines(keepends=True)
    current_lines = current.splitlines(keepends=True)
    if len(template_lines) != len(rendered_lines):
        return current
    output: list[str] = []
    matcher = difflib.SequenceMatcher(None, rendered_lines, current_lines, autojunk=False)
    for operation, rendered_start, rendered_end, current_start, current_end in matcher.get_opcodes():
        if operation != "equal":
            output.extend(current_lines[current_start:current_end])
            continue
        for offset, current_line in enumerate(current_lines[current_start:current_end]):
            template_line = template_lines[rendered_start + offset]
            output.append(template_line if VARIABLE_PLACEHOLDER.search(template_line) else current_line)
    return "".join(output)


def remote_snapshot(
    config: Config,
) -> RemoteSnapshot:
    payload = api_call(config, desired_configuration_path(config), parse_json=True)
    version_payload = payload.get("version") if isinstance(payload, dict) else None
    if not isinstance(version_payload, dict):
        raise CliError("no desired configuration found")
    version_number = version_payload.get("version_number")
    files = version_payload.get("files")
    if not isinstance(version_number, int) or not isinstance(files, list):
        raise CliError("server returned an invalid repository version")
    validated: list[dict[str, Any]] = []
    validated_paths: dict[str, str] = {}
    for file in files:
        if not isinstance(file, dict):
            raise CliError("server returned an invalid config file")
        relative = file.get("path")
        content = file.get("content")
        if not isinstance(relative, str) or not isinstance(content, str) or not safe_config_path(relative):
            raise CliError("server returned an unsafe config path")
        collision_key = config_path_collision_key(relative)
        colliding_path = validated_paths.get(collision_key)
        if colliding_path is not None:
            raise CliError(
                f"server returned colliding config paths: {colliding_path} and {relative}"
            )
        validated_paths[collision_key] = relative
        validated.append(file)
    printer_payload = payload.get("printer") if isinstance(payload, dict) else None
    profile_values = printer_payload.get("variableValues") if isinstance(printer_payload, dict) else None
    values = {}
    if isinstance(profile_values, dict):
        for name, value in profile_values.items():
            if not VARIABLE_NAME.fullmatch(name):
                continue
            normalized = variable_value(value)
            if normalized is not None:
                values[name] = normalized
    # Host-local values take precedence so secrets never need to leave the printer.
    values.update(local_variable_values(config))
    rendered_files, rendered_names = render_snapshot_variables(validated, values)
    revision = version_payload.get("revision")
    if not isinstance(revision, str):
        revision = ""
    version_id = version_payload.get("id")
    applied_version_number = (
        printer_payload.get("appliedVersionId")
        if isinstance(printer_payload, dict) and isinstance(printer_payload.get("appliedVersionId"), int)
        else None
    )
    return RemoteSnapshot(
        applied_version_number=applied_version_number,
        created_at=str(version_payload.get("created_at") or ""),
        files=rendered_files,
        pending=version_payload.get("source") == "pending",
        rendered_names=rendered_names,
        revision=revision,
        source=str(version_payload.get("source") or ""),
        template_files=validated,
        version_id=version_id if isinstance(version_id, str) else "",
        version_number=version_number,
    )


def managed_config_path(config: Config, relative: str) -> Path:
    """Return a writable config path without following an out-of-tree link."""
    if not safe_config_path(relative):
        raise CliError(f"refusing to manage unsafe config path: {relative}")
    root = config.config_dir.resolve()
    path = config.config_dir.joinpath(*PurePosixPath(relative.replace("\\", "/")).parts)
    try:
        path.parent.resolve().relative_to(root)
    except (OSError, ValueError) as error:
        raise CliError(
            f"refusing to modify linked config outside {config.config_dir}: {relative}"
        ) from error
    if path.is_symlink():
        raise CliError(f"refusing to replace linked config file: {relative}")
    return path


def validate_managed_changes(config: Config, changes: Iterable[tuple[str, str]]) -> None:
    """Validate the complete mutation set before backups or partial writes."""
    for action, relative in changes:
        if action in {"add", "update", "remove"}:
            managed_config_path(config, relative)


def apply_snapshot(
    config: Config,
    snapshot: RemoteSnapshot,
    changes: Iterable[tuple[str, str]],
) -> None:
    config.config_dir.mkdir(parents=True, exist_ok=True)
    actions = {relative: action for action, relative in changes}
    for relative, action in actions.items():
        if action != "remove":
            continue
        stale = managed_config_path(config, relative)
        if stale.is_file():
            stale.unlink()
    for file in snapshot.files:
        relative = str(file["path"])
        if actions.get(relative) not in {"add", "update"}:
            continue
        destination = managed_config_path(config, relative)
        write_atomic_text(destination, str(file["content"]))
    write_sync_metadata(config, {
        "version": snapshot.version_number,
        "version_id": snapshot.version_id,
        "revision": snapshot.revision,
        "source": snapshot.source,
        "created_at": snapshot.created_at,
        "synced_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })


def nested_string(payload: Any, name: str) -> str:
    if isinstance(payload, dict):
        value = payload.get(name)
        if isinstance(value, str):
            return value
        for nested in payload.values():
            result = nested_string(nested, name)
            if result:
                return result
    elif isinstance(payload, list):
        for nested in payload:
            result = nested_string(nested, name)
            if result:
                return result
    return ""


def moonraker_json(path: str) -> Any:
    base = os.environ.get("KLIPPEE_MOONRAKER_URL", "http://127.0.0.1:7125").rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}{path}", timeout=2) as response:
            raw = response.read(MAX_DIAGNOSTIC_SNAPSHOT_BYTES + 1)
            if len(raw) > MAX_DIAGNOSTIC_SNAPSHOT_BYTES:
                return {}
            return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def os_name() -> str:
    release = Path("/etc/os-release")
    if not release.is_file():
        return platform.platform()
    for line in release.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("PRETTY_NAME="):
            raw = line.partition("=")[2]
            try:
                parsed = shlex.split(raw, posix=True)
            except ValueError:
                return raw.strip("\"'")
            return parsed[0] if parsed else ""
    return platform.platform()


def collect_host_info(config: Config | None = None) -> dict[str, str]:
    if config is None:
        printer = moonraker_json("/printer/info")
        server = moonraker_json("/server/info")
    else:
        printer = diagnostic_moonraker_request(config, "/printer/info", "printer.info")
        server = diagnostic_moonraker_request(config, "/server/info", "server.info")
    return {
        "os": os_name(),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "hostname": socket.gethostname(),
        "cliVersion": CLI_VERSION,
        "klipperVersion": nested_string(printer, "software_version"),
        "klippyState": nested_string(printer, "state"),
        "moonrakerVersion": nested_string(server, "moonraker_version"),
    }


def diagnostic_system_text(path: Path, maximum: int = 4096) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()[:maximum]
    except OSError:
        return ""


def diagnostic_service_scheduling(name: str) -> dict[str, str]:
    result = {
        "name": name,
        "activeState": "",
        "cpuAffinity": "",
        "cpuAllowedList": "",
    }
    systemctl = resolve_program("systemctl")
    if systemctl is None:
        return result
    try:
        query = subprocess.run(
            [
                systemctl,
                "show",
                name,
                "--property=ActiveState",
                "--property=MainPID",
                "--property=CPUAffinity",
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return result
    values = {}
    for line in query.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value.strip()
    result["activeState"] = values.get("ActiveState", "")
    result["cpuAffinity"] = values.get("CPUAffinity", "")
    main_pid = values.get("MainPID", "")
    if main_pid.isdigit() and main_pid != "0":
        status = diagnostic_system_text(Path("/proc") / main_pid / "status", 128 * 1024)
        for line in status.splitlines():
            if line.startswith("Cpus_allowed_list:"):
                result["cpuAllowedList"] = line.partition(":")[2].strip()
                break
    return result


def diagnostic_service_state(name: str) -> str:
    systemctl = resolve_program("systemctl")
    if systemctl is None:
        return ""
    try:
        result = subprocess.run(
            [systemctl, "is-active", name],
            capture_output=True,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip()[:80]


def collect_host_scheduling_info() -> dict[str, Any]:
    governors = {}
    cpufreq = Path("/sys/devices/system/cpu/cpufreq")
    if cpufreq.is_dir():
        for policy in sorted(cpufreq.glob("policy*"))[:64]:
            governor = diagnostic_system_text(policy / "scaling_governor", 80)
            if governor:
                governors[policy.name] = governor

    serial_irqs = []
    tty_root = Path("/sys/class/tty")
    if tty_root.is_dir():
        for tty in sorted(tty_root.iterdir(), key=lambda path: path.name)[:256]:
            raw_irq = diagnostic_system_text(tty / "device" / "irq", 32)
            if not raw_irq.isdigit():
                continue
            irq = int(raw_irq)
            if irq < 0:
                continue
            serial_irqs.append({
                "device": tty.name,
                "irq": irq,
                "requestedCpuList": diagnostic_system_text(
                    Path("/proc/irq") / str(irq) / "smp_affinity_list",
                    256,
                ),
                "effectiveCpuList": diagnostic_system_text(
                    Path("/proc/irq") / str(irq) / "effective_affinity_list",
                    256,
                ),
            })
            if len(serial_irqs) >= 64:
                break

    return {
        "onlineCpus": diagnostic_system_text(Path("/sys/devices/system/cpu/online"), 256),
        "governors": governors,
        "serialIrqs": serial_irqs,
        "services": [
            diagnostic_service_scheduling(name)
            for name in ("klipper", "moonraker", "nginx", "crowsnest")
        ],
        "irqbalanceState": diagnostic_service_state("irqbalance.service"),
        "ondemandState": diagnostic_service_state("ondemand.service"),
    }


def collect_usb_serial_topology(
    by_id_root: Path = Path("/dev/serial/by-id"),
    tty_root: Path = Path("/sys/class/tty"),
) -> dict[str, Any]:
    """Capture a bounded map from stable serial names to kernel USB paths.

    Klipper records configured ``/dev/serial/by-id`` names while the kernel
    reports disconnects as topology paths such as ``2-1.2.1.2``. Keeping both
    in a private diagnostic bundle lets the analyzer correlate those records
    without a later SSH session. Only USB serial symlinks and small, fixed
    sysfs identity attributes are read.
    """
    devices = []
    if not by_id_root.is_dir() or not tty_root.is_dir():
        return {"devices": devices}
    try:
        entries = sorted(by_id_root.iterdir(), key=lambda path: path.name)[:64]
    except OSError:
        return {"devices": devices}
    for entry in entries:
        if not entry.is_symlink() or len(entry.name) > 240:
            continue
        try:
            tty_name = entry.resolve(strict=True).name
        except OSError:
            continue
        if not USB_SERIAL_TTY.fullmatch(tty_name):
            continue
        try:
            tty_device = (tty_root / tty_name / "device").resolve(strict=True)
        except OSError:
            continue
        usb_device = None
        for candidate in (tty_device,) + tuple(tty_device.parents):
            if USB_TOPOLOGY_PATH.fullmatch(candidate.name):
                usb_device = candidate
                break
        if usb_device is None:
            continue
        devices.append({
            "byId": f"/dev/serial/by-id/{entry.name}",
            "manufacturer": diagnostic_system_text(usb_device / "manufacturer", 256),
            "product": diagnostic_system_text(usb_device / "product", 256),
            "productId": diagnostic_system_text(usb_device / "idProduct", 16),
            "serial": diagnostic_system_text(usb_device / "serial", 256),
            "tty": f"/dev/{tty_name}",
            "usbPath": usb_device.name,
            "vendorId": diagnostic_system_text(usb_device / "idVendor", 16),
        })
    return {"devices": devices}


def report_host_info(config: Config) -> None:
    if config.client_mode == "desktop":
        return
    try:
        api_call(
            config,
            f"/api/sync/repos/{config.repository_id}/host-info",
            method="POST",
            payload={"hostInfo": collect_host_info(config)},
            parse_json=True,
        )
    except CliError as error:
        eprint("klippee: warning: could not report host info")
        for line in str(error).splitlines():
            eprint(f"klippee:   {line}")
    except Exception as error:
        eprint(f"klippee: warning: could not report host info: {error}")


def parse_init_args(args: list[str]) -> tuple[str, list[str]]:
    mode = normalize_client_mode(os.environ.get("KLIPPEE_CLIENT_MODE", "printer"))
    values: list[str] = []
    parse_options = True
    for argument in args:
        if parse_options and argument == "--":
            parse_options = False
        elif parse_options and argument == "--desktop":
            mode = "desktop"
        elif parse_options and argument == "--printer":
            mode = "printer"
        elif parse_options and argument.startswith("-"):
            raise CliError(f"unknown init option: {argument}")
        else:
            values.append(argument)
    if len(values) > 4:
        raise CliError("init accepts base URL, repository ID, token, and config directory")
    return mode, values


def cmd_init(args: list[str]) -> int:
    client_mode, values = parse_init_args(args)
    default_config_dir = Path.cwd() if client_mode == "desktop" else home_dir() / "printer_data" / "config"
    defaults = [
        os.environ.get("KLIPPEE_BASE_URL", "https://klippee.xyz"),
        os.environ.get("KLIPPEE_REPOSITORY_ID", ""),
        os.environ.get("KLIPPEE_TOKEN", ""),
        os.environ.get("KLIPPEE_CONFIG_DIR", str(default_config_dir)),
    ]
    for index, value in enumerate(values):
        defaults[index] = value
    config = write_config(*defaults, client_mode=client_mode)
    print(f"klippee: configured {config.client_mode} workspace at {config.config_dir}")
    return 0


def parse_status_text(raw: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in raw.splitlines():
        name, separator, value = line.partition("=")
        if separator:
            values[name.strip()] = value.strip()
    return values


def sync_status(config: Config, required: bool = True) -> dict[str, str]:
    try:
        raw = api_call(config, f"/api/sync/repos/{config.repository_id}/status.txt")
    except CliError:
        if required:
            raise
        return {}
    values = parse_status_text(raw)
    if required and not values:
        raise CliError("server returned invalid target information")
    return values


def service_environment(base_url: str) -> str:
    hostname = (urllib.parse.urlparse(base_url).hostname or "").lower()
    if hostname in {"127.0.0.1", "localhost"} or hostname.endswith(".local"):
        return "local"
    if any(label in hostname for label in ("dev", "preview", "staging")):
        return "staging"
    return "production"


def target_label(config: Config, status: dict[str, str]) -> str:
    name = status.get("printer_name") or "Unidentified printer"
    identifier = status.get("printer_id") or config.repository_id
    return f"{name} ({identifier})"


def print_target_summary(config: Config, status: dict[str, str]) -> None:
    print(f"Target:  {target_label(config, status)}")
    print(f"Service: {service_environment(config.base_url)} — {config.base_url}")
    print(f"Role:    {'physical printer' if config.client_mode == 'printer' else 'desktop workspace'}")
    print(f"Folder:  {config.config_dir}")


def status_version_summary(status: dict[str, str], prefix: str) -> str:
    version = status.get(f"{prefix}_version")
    if not version:
        return "none recorded"
    summary = f"version {version}"
    if prefix == "target" and status.get("target_pending", "").lower() in {"1", "true", "yes"}:
        summary += " (pending)"
    timestamp_name = "applied_at" if prefix == "applied" else "target_created_at"
    if status.get(timestamp_name):
        summary += f" at {status[timestamp_name]}"
    return summary


def target_sync_state(status: dict[str, str]) -> str:
    applied = status.get("applied_version")
    target = status.get("target_version")
    if status.get("target_pending", "").lower() in {"1", "true", "yes"}:
        return "pending configuration"
    if applied and target and applied == target:
        return "up to date"
    if applied and target:
        return "update available"
    if target:
        return "not yet applied"
    if applied:
        return "desired configuration unavailable"
    return "no version information"


def cmd_target(args: list[str]) -> int:
    if args:
        raise CliError("target does not accept arguments")
    config = load_config()
    status = sync_status(config)
    print_target_summary(config, status)
    print(f"Applied: {status_version_summary(status, 'applied')}")
    print(f"Desired: {status_version_summary(status, 'target')}")
    print(f"State:   {target_sync_state(status)}")
    return 0


def relevant_local_paths(config: Config) -> list[str]:
    paths = set(config_files(config.config_dir))
    paths.update(
        relative
        for relative in read_manifest(config)
        if safe_config_path(relative) and (config.config_dir / relative).is_file()
    )
    return sorted(paths)


def configuration_changes(config: Config, files: list[dict[str, Any]]) -> list[tuple[str, str]]:
    remote_by_path = {str(file["path"]): str(file["content"]) for file in files}
    local_paths = set(relevant_local_paths(config))
    changes: list[tuple[str, str]] = []
    for relative, content in sorted(remote_by_path.items()):
        local_file = config.config_dir / relative
        if not local_file.is_file():
            changes.append(("add", relative))
            continue
        local_content = local_file.read_text(encoding="utf-8", errors="replace")
        if diff_content_lines(content) != diff_content_lines(local_content):
            changes.append(("update", relative))
    for relative in sorted(local_paths - set(remote_by_path)):
        changes.append(("remove", relative))
    return changes


def print_configuration_diff(config: Config, files: list[dict[str, Any]]) -> None:
    remote_paths: set[str] = set()
    wrote_output = False
    for file in sorted(files, key=lambda candidate: str(candidate["path"])):
        relative = str(file["path"])
        remote_paths.add(relative)
        local_file = config.config_dir / relative
        if not local_file.is_file():
            print(f"Only in desired configuration: {relative}")
            wrote_output = True
            continue
        remote_lines = diff_content_lines(str(file["content"]))
        local_lines = diff_content_lines(local_file.read_text(encoding="utf-8", errors="replace"))
        diff = list(
            difflib.unified_diff(
                remote_lines,
                local_lines,
                fromfile=f"desired/{relative}",
                tofile=f"local/{relative}",
            )
        )
        if diff:
            sys.stdout.writelines(diff)
            wrote_output = True
    for relative in relevant_local_paths(config):
        if relative not in remote_paths:
            print(f"Only local: {relative}")
            wrote_output = True
    if not wrote_output:
        print("No file differences.")


def cmd_check(args: list[str]) -> int:
    show_diff = False
    for argument in args:
        if argument == "--diff":
            show_diff = True
        else:
            raise CliError(f"unknown check option: {argument}")
    config = load_config()
    status = sync_status(config)
    snapshot = remote_snapshot(config)
    changes = configuration_changes(config, snapshot.files)
    baseline = read_sync_metadata(config)
    baseline_revision = baseline.get("revision", "")
    remote_changed = bool(baseline_revision and snapshot.revision and baseline_revision != snapshot.revision)
    local_changed = bool(local_changed_files(config))
    print_target_summary(config, status)
    if changes:
        if remote_changed and local_changed:
            print("State:   diverged — both this workspace and the printer target changed")
        elif local_changed:
            print("State:   local edits")
        elif remote_changed:
            print("State:   printer target changed")
        else:
            print("State:   differences found (workspace baseline unverified)")
        print(f"Drift:   {len(changes)} configuration path{'s' if len(changes) != 1 else ''} differ from desired")
        print("Changes:")
        for action, relative in changes:
            print(f"  {action} {relative}")
        print("\nChoose 'klippee apply' to use the desired configuration or 'klippee capture' to keep local files.")
    else:
        print("State:   current")
    if snapshot.rendered_names:
        print(f"Values:  rendered {', '.join(sorted(snapshot.rendered_names))}")
    if show_diff:
        print("\nConfiguration diff:")
        print_configuration_diff(config, snapshot.files)
    return 0


def parse_apply_args(args: list[str]) -> str:
    mode = "prompt"
    for argument in args:
        if argument not in {"--yes", "--if-clean"}:
            raise CliError(f"unknown apply option: {argument}")
        selected = "yes" if argument == "--yes" else "if-clean"
        if mode != "prompt" and mode != selected:
            raise CliError("apply accepts only one of --yes or --if-clean")
        mode = selected
    return mode


def confirm_apply(changes: list[tuple[str, str]], assume_yes: bool) -> None:
    if not changes or assume_yes:
        return
    if not sys.stdin.isatty():
        raise CliError("apply requires confirmation when local files differ; rerun with 'klippee apply --yes'")
    answer = input("Replace these local files with the desired configuration? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise CliError("apply cancelled without changing files")


def report_applied(config: Config, snapshot: RemoteSnapshot) -> dict[str, Any]:
    if config.client_mode != "printer":
        return {}
    response = api_call(
        config,
        f"/api/sync/repos/{config.repository_id}/applied",
        method="POST",
        payload={
            "protocolVersion": 2,
            "versionNumber": snapshot.version_number,
            "desiredRevision": snapshot.revision,
            "files": snapshot.template_files,
        },
        parse_json=True,
    )
    if not isinstance(response, dict):
        raise CliError("server returned an invalid applied-state response")
    return response


def cmd_apply(args: list[str], expected_revision: str = "") -> int:
    apply_mode = parse_apply_args(args)
    config = load_config()
    config.config_dir.mkdir(parents=True, exist_ok=True)
    if apply_mode == "if-clean":
        require_clean_sync_baseline(config)
    status = sync_status(config)
    snapshot = remote_snapshot(config)
    if expected_revision and snapshot.revision != expected_revision:
        raise CliError("desired configuration changed after recovery; the selected recovery point was not applied")
    changes = configuration_changes(config, snapshot.files)
    print("Applying desired configuration to:")
    print_target_summary(config, status)
    if changes:
        print("Changes:")
        for action, relative in changes:
            print(f"  {action} {relative}")
    validate_managed_changes(config, changes)
    confirm_apply(changes, apply_mode != "prompt")
    confirmed_snapshot = remote_snapshot(config)
    if (
        snapshot.revision
        and confirmed_snapshot.revision
        and snapshot.revision != confirmed_snapshot.revision
    ) or snapshot.template_files != confirmed_snapshot.template_files or snapshot.files != confirmed_snapshot.files:
        raise CliError("desired configuration changed during review; no local files were changed, run klippee check again")
    snapshot = confirmed_snapshot
    current_backup = backup_config_dir(config) if changes else None
    if apply_mode == "if-clean":
        # Recheck after the potentially slow backup so edits made during target
        # review or backup creation are still refused before any managed file is
        # replaced or removed.
        require_clean_sync_baseline(config)
    if changes:
        apply_snapshot(config, snapshot, changes)
    else:
        write_sync_metadata(config, {
            "version": snapshot.version_number,
            "version_id": snapshot.version_id,
            "revision": snapshot.revision,
            "source": snapshot.source,
            "created_at": snapshot.created_at,
            "synced_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
    write_sync_baseline(config, (str(file["path"]) for file in snapshot.files))
    write_variable_templates(config, snapshot.template_files, snapshot.files)
    try:
        applied_response = report_applied(config, snapshot)
    except CliError:
        eprint("klippee: files were installed locally, but cloud confirmation failed; the server did not advance applied state")
        raise
    if snapshot.rendered_names:
        print(f"Rendered printer values: {', '.join(sorted(snapshot.rendered_names))}")
    if current_backup is not None:
        print(f"Backup:  {current_backup}")
        print(f"Updated: {len(changes)} configuration path{'s' if len(changes) != 1 else ''}")
    else:
        print("Updated: no file changes required")
    if applied_response.get("desiredChanged") is True:
        print(f"Result:  {target_label(config, status)} installed this snapshot; a newer draft is available")
    else:
        print(f"Result:  {target_label(config, status)} is current")
    if config.client_mode == "printer" and changes:
        print("Restart Klipper when ready.")
    report_host_info(config)
    return 0


def diff_content_lines(content: str) -> list[str]:
    """Hide volatile printer calibration profiles from human-readable diffs."""
    lines = content.splitlines(keepends=True)
    marker_index = next(
        (
            index
            for index, line in enumerate(lines)
            if SAVE_CONFIG_MARKER.match(line.rstrip("\r\n"))
        ),
        None,
    )
    if marker_index is None:
        return lines

    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    current_name = ""
    current_lines: list[str] = []
    for line in lines[marker_index:]:
        section_match = SAVE_CONFIG_SECTION.match(line.rstrip("\r\n"))
        if section_match:
            if current_lines:
                sections.append((current_name, current_lines))
            current_name = section_match.group(1).strip()
            current_lines = [line]
        elif current_lines:
            current_lines.append(line)
        else:
            preamble.append(line)
    if current_lines:
        sections.append((current_name, current_lines))
    if not sections:
        return lines

    kept_sections = [
        section
        for section in sections
        if not VOLATILE_SAVE_CONFIG_SECTION.match(section[0])
    ]
    if not kept_sections:
        return lines[:marker_index]

    newline = "\r\n" if any(line.endswith("\r\n") for line in lines) else "\n"

    def trim_separators(section_lines: list[str]) -> list[str]:
        trimmed = list(section_lines)
        while trimmed and SAVE_CONFIG_SEPARATOR.match(trimmed[-1].rstrip("\r\n")):
            trimmed.pop()
        return trimmed

    normalized = trim_separators(preamble)
    for _name, section_lines in kept_sections:
        normalized.append(f"#*#{newline}")
        normalized.extend(trim_separators(section_lines))
    return [*lines[:marker_index], *normalized]


def remote_versions(config: Config) -> list[dict[str, Any]]:
    payload = api_call(
        config,
        f"/api/sync/repos/{config.repository_id}/versions",
        parse_json=True,
    )
    versions = payload.get("versions") if isinstance(payload, dict) else None
    if not isinstance(versions, list):
        raise CliError("server returned an invalid version history")
    validated: list[dict[str, Any]] = []
    for version in versions:
        if not isinstance(version, dict) or not isinstance(version.get("version_number"), int):
            raise CliError("server returned an invalid version history")
        validated.append(version)
    return sorted(validated, key=lambda version: int(version["version_number"]), reverse=True)


def local_recovery_points(config: Config) -> list[Path]:
    root = config.config_dir / ".klippee" / "backups"
    if not root.is_dir():
        return []
    return sorted((path for path in root.iterdir() if path.is_dir() and not path_is_link(path)), reverse=True)


def print_recovery_points(
    config: Config,
    versions: list[dict[str, Any]],
    desired: RemoteSnapshot | None,
) -> None:
    print("Cloud recovery points:")
    if not versions:
        print("  none")
    else:
        latest_number = versions[0]["version_number"]
        if desired and desired.pending:
            print("  pending draft (desired; choose a cloud recovery point to replace it)")
        for version in versions:
            number = version["version_number"]
            labels: list[str] = []
            if desired and number == desired.applied_version_number:
                labels.append("applied")
            if desired and not desired.pending and number == desired.version_number:
                labels.append("desired")
            elif desired and desired.pending and number == latest_number:
                labels.append("latest saved; selecting cancels draft")
            label = f" ({', '.join(labels)})" if labels else ""
            created = str(version.get("created_at") or "").replace("T", " ")[:19]
            message = str(version.get("message") or "Saved configuration")
            print(f"  cloud:{number}{label}  {created}  {message}")
    print("Local recovery points:")
    local = local_recovery_points(config)
    if not local:
        print("  none")
    for path in local:
        print(f"  local:{path.name}")


def restore_local_recovery_point(config: Config, name: str) -> int:
    if not name or Path(name).name != name:
        raise CliError("invalid local recovery point")
    local_state = config.config_dir / ".klippee"
    backups_root = local_state / "backups"
    source = backups_root / name
    if path_is_link(local_state) or path_is_link(backups_root) or path_is_link(source):
        raise CliError(f"refusing to restore linked recovery point: local:{name}")
    if not source.is_dir():
        raise CliError(f"local recovery point not found: local:{name}")
    try:
        local_state.resolve().relative_to(config.config_dir.resolve())
        backups_root.resolve().relative_to(local_state.resolve())
        source.resolve().relative_to(backups_root.resolve())
    except (OSError, ValueError) as error:
        raise CliError(f"refusing to restore linked recovery point: local:{name}") from error
    source_root = source.resolve()
    restore_files: list[tuple[str, Path, Path]] = []
    for relative in local_recovery_files(source):
        source_file = source / relative
        try:
            source_file.resolve(strict=True).relative_to(source_root)
        except (OSError, ValueError) as error:
            raise CliError(f"refusing to restore linked recovery file: {relative}") from error
        if path_is_link(source_file):
            raise CliError(f"refusing to restore linked recovery file: {relative}")
        parent = source
        for part in PurePosixPath(relative).parts[:-1]:
            parent = parent / part
            if path_is_link(parent):
                raise CliError(f"refusing to restore linked recovery file: {relative}")
        restore_files.append((relative, source_file, managed_config_path(config, relative)))
    changes, changed_names = restore_changes(config, restore_files)
    current_backup = backup_config_dir(config)
    for relative, source_file, destination in restore_files:
        if relative not in changed_names:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, destination)
    print(f"Recovered local files from local:{name}")
    print(f"Backup: {current_backup}")
    print("Changes:")
    print("\n".join(changes) if changes else "  none")
    print("Run 'klippee check' to compare the recovered files with the desired configuration.")
    return 0


def cmd_recover(args: list[str]) -> int:
    if len(args) > 1:
        raise CliError("recover accepts at most one recovery point")
    config = load_config()
    selection = args[0] if args else ""
    if selection.startswith("local:"):
        return restore_local_recovery_point(config, selection[len("local:"):])
    if selection and not selection.startswith("cloud:"):
        raise CliError("recovery points use 'cloud:<id>' or 'local:<name>'; run 'klippee recover' to list them")
    versions = remote_versions(config)
    desired = remote_snapshot(config) if versions else None
    if not selection:
        print_recovery_points(config, versions, desired)
        return 0
    if config.client_mode != "printer":
        raise CliError("cloud recovery can only be applied by the physical printer")
    selected = selection[len("cloud:"):]
    candidates = {int(version["version_number"]) for version in versions}
    if desired and not desired.pending:
        candidates.discard(desired.version_number)
    if not selected.isdigit() or int(selected) not in candidates:
        raise CliError(f"cloud recovery point not found or already desired: {selection}")
    response = api_call(
        config,
        f"/api/sync/repos/{config.repository_id}/rollback",
        method="POST",
        payload={"versionNumber": int(selected)},
        parse_json=True,
    )
    version = response.get("version") if isinstance(response, dict) else None
    if not isinstance(version, dict) or not isinstance(version.get("version_number"), int):
        raise CliError("server returned an invalid recovered configuration")
    print(f"Recovered {selection} as the desired configuration.")
    recovered_revision = version.get("revision") if isinstance(version.get("revision"), str) else ""
    return cmd_apply(["--yes"], expected_revision=recovered_revision)


def variables_path(config: Config) -> Path:
    target = config.config_dir / LOCAL_VARIABLES_NAME
    legacy = config.config_dir / ".klippee" / "variables.env"
    if not target.is_file() and legacy.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        entries = []
        for line in read_variables(legacy):
            entry = parse_variable_entry(line)
            if entry is not None:
                entries.append(f"{VARIABLE_ENTRY_PREFIX}{entry[0]}={entry[1]}")
        write_atomic_text(
            target,
            VARIABLES_FILE_HEADER + "".join(f"{line}\n" for line in entries),
            mode=0o600,
        )
        unlink_if_exists(legacy)
    return target


def read_variables(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines() if path.is_file() else []


def cmd_variables(args: list[str]) -> int:
    config = load_config()
    target = variables_path(config)
    target.parent.mkdir(parents=True, exist_ok=True)
    action = args[0] if args else "list"
    if action == "list":
        if target.is_file():
            print(target.read_text(encoding="utf-8"), end="")
        return 0
    if action in {"set", "unset"}:
        if len(args) < 2:
            raise CliError("variable name is required")
        name = args[1]
        if VARIABLE_NAME.fullmatch(name) is None:
            raise CliError("variable names must match [a-z][a-z0-9_]*")
        lines = read_variables(target)
        if not lines:
            lines = VARIABLES_FILE_HEADER.rstrip("\n").splitlines()
        lines = [
            line
            for line in lines
            if (parse_variable_entry(line) or (None, None))[0] != name
        ]
        if action == "set":
            value = args[2] if len(args) > 2 else ""
            if "\n" in value or "\r" in value:
                raise CliError("variable values must fit on one line")
            lines.append(f"{VARIABLE_ENTRY_PREFIX}{name}={value}")
        write_atomic_text(target, "".join(f"{line}\n" for line in lines), mode=0o600)
        print(f"klippee: {'set' if action == 'set' else 'unset'} {name}")
        return 0
    if action == "doctor":
        raw_lines = read_variables(target)
        entries = [parse_variable_entry(line) for line in raw_lines]
        entries = [entry for entry in entries if entry is not None]
        invalid = [
            line
            for line in raw_lines
            if line.strip()
            and (
                line.strip().startswith(VARIABLE_ENTRY_PREFIX)
                or not line.lstrip().startswith("#")
            )
            and parse_variable_entry(line) is None
        ]
        if invalid:
            for line in invalid:
                print(f"invalid: {line}")
            raise CliError("variables are invalid")
        if not entries:
            # An empty variables file is an informational state, not a failure.
            print("klippee: no variables set")
            return 0
        print("klippee: variables look valid")
        return 0
    raise CliError(f"unknown variables command: {action}")


def parse_capture_args(args: list[str]) -> str:
    note = ""
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--note":
            index += 1
            if index >= len(args) or not args[index].strip():
                raise CliError("capture --note requires text")
            note = args[index].strip()
        else:
            raise CliError(f"unknown capture option: {argument}")
        index += 1
    return note


def cmd_capture(args: list[str]) -> int:
    note = parse_capture_args(args)
    config = load_config()
    if not config.config_dir.is_dir():
        raise CliError(f"config directory not found: {config.config_dir}")
    status = sync_status(config, required=False)
    print("Capturing configuration from:")
    print_target_summary(config, status)
    selected = config_files(config.config_dir)
    if not selected:
        raise CliError(f"no safe Klipper .cfg files found in {config.config_dir}")
    rejected = rejected_config_files(config.config_dir)
    if rejected:
        eprint("klippee: skipped unreferenced, backup, or sensitive files:")
        for relative in rejected:
            eprint(f"  - {relative}")
    if len(selected) > MAX_FILES:
        raise CliError(
            f"cannot capture {len(selected)} config files; the server accepts at most {MAX_FILES} per capture\n"
            f"move old backups or unused .cfg files out of {config.config_dir} and retry"
        )
    variable_templates = read_variable_templates(config)
    files: list[dict[str, Any]] = []
    rendered_files: list[dict[str, Any]] = []
    for relative in selected:
        path = config.config_dir / relative
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise CliError(
                f"cannot capture {relative} ({size} bytes); the server accepts files up to {MAX_FILE_BYTES} bytes"
            )
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise CliError(f"cannot capture non-UTF-8 config file: {relative}") from error
        file = {"path": relative, "role": file_role(relative), "public": False, "content": content}
        rendered_files.append(file)
        files.append({
            **file,
            "content": restore_variable_placeholders(relative, content, variable_templates),
        })
    baseline = read_sync_metadata(config)
    payload: dict[str, Any] = {
        "protocolVersion": 2,
        "clientMode": config.client_mode,
        "message": note or ("Captured from printer" if config.client_mode == "printer" else "Captured from desktop"),
        "files": files,
    }
    if baseline.get("revision"):
        payload["baseRevision"] = baseline["revision"]
    if baseline.get("version", "").isdigit():
        payload["baseVersionNumber"] = int(baseline["version"])
    try:
        response = api_call(
            config,
            f"/api/sync/repos/{config.repository_id}/push",
            method="POST",
            payload=payload,
            parse_json=True,
        )
    except ApiError as error:
        code = error.payload.get("code") if isinstance(error.payload, dict) else ""
        if error.status == 409 and code in {"desired_configuration_conflict", "workspace_baseline_required"}:
            eprint("klippee: capture stopped; no cloud state or workspace baseline was changed")
            eprint("klippee: run 'klippee check --diff', then apply the printer target or retry after synchronizing")
        raise
    if not isinstance(response, dict):
        raise CliError("server returned an invalid capture response")
    write_variable_templates(config, files, rendered_files)
    version = response.get("version")
    desired = response.get("desired")
    version_payload = version if isinstance(version, dict) else {}
    desired_payload = desired if isinstance(desired, dict) else {}
    write_sync_metadata(config, {
        "version": version_payload.get("version_number", desired_payload.get("versionNumber", "")),
        "version_id": version_payload.get("id", desired_payload.get("versionId", "")),
        "revision": version_payload.get("revision", desired_payload.get("revision", "")),
        "source": version_payload.get("source", "capture"),
        "created_at": version_payload.get("created_at", desired_payload.get("createdAt", "")),
        "note": note,
        "captured_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    write_sync_baseline(config)
    report_host_info(config)
    unchanged = response.get("unchanged") is True if isinstance(response, dict) else False
    if unchanged:
        print("Result: desired configuration was already identical")
    else:
        file_label = "file" if len(files) == 1 else "files"
        print(f"Captured: {len(files)} configuration {file_label}")
        if config.client_mode == "printer":
            print(f"Result:   {target_label(config, status)} is now the last confirmed printer configuration")
        else:
            print("Result:   draft updated; the physical printer has not applied it")
    return 0


def default_diagnostic_log(config: Config) -> Path:
    configured = os.environ.get("KLIPPEE_LOG_PATH")
    candidates = [
        Path(configured).expanduser() if configured else None,
        config.config_dir.parent / "logs" / "klippy.log",
        home_dir() / "printer_data" / "logs" / "klippy.log",
        home_dir() / "klipper_logs" / "klippy.log",
        Path("/tmp/klippy.log"),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    searched = ", ".join(str(candidate) for candidate in candidates if candidate is not None)
    raise CliError(
        "could not find klippy.log; pass its path to 'klippee upload-diagnostics' "
        f"or set KLIPPEE_LOG_PATH (searched: {searched})"
    )


def diagnostic_json(payload: Any) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def moonraker_result(payload: Any) -> Any:
    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    return payload


def diagnostic_object_query(objects: list[str]) -> str:
    return "/printer/objects/query?" + "&".join(urllib.parse.quote(name, safe="") for name in objects)


def read_etx_frame(receive_chunk: Any, pending: bytes, max_buffer: int) -> tuple[bytes, bytes]:
    """Read one non-empty ETX-delimited frame, returning (frame, remainder).

    Raises OSError when the peer closes the connection or streams more than
    ``max_buffer`` bytes without a frame terminator, so long-lived callers can
    treat both as a connection failure and reconnect.
    """
    while True:
        while ETX not in pending:
            chunk = receive_chunk(65536)
            if not chunk:
                raise OSError("Moonraker closed the connection")
            pending += chunk
            if len(pending) > max_buffer:
                raise OSError("Moonraker sent an unterminated frame beyond the buffer limit")
        frame, pending = pending.split(ETX, 1)
        if frame:
            return frame, pending


def moonraker_rpc(config: Config, method: str, params: dict[str, Any] | None = None) -> Any:
    path = moonraker_socket_path(config)
    if not hasattr(socket, "AF_UNIX") or not path.is_socket():
        return {}
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    request_id = 1
    deadline = time.monotonic() + 2.0

    def receive_chunk(size: int) -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0.0:
            raise OSError("Moonraker response deadline exceeded")
        connection.settimeout(remaining)
        return connection.recv(size)

    try:
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        connection.connect(str(path))
        request = {
            "jsonrpc": "2.0",
            "method": method,
            "id": request_id,
        }
        if params:
            request["params"] = params
        connection.sendall(json.dumps(request, separators=(",", ":")).encode("utf-8") + ETX)
        pending = b""
        while True:
            raw, pending = read_etx_frame(receive_chunk, pending, MAX_DIAGNOSTIC_SNAPSHOT_BYTES)
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict) or payload.get("id") != request_id:
                # Moonraker UDS connections may interleave notifications and
                # unrelated responses. Only the response to this exact query
                # may authorize a configuration mutation.
                continue
            if "error" in payload or "result" not in payload:
                return {}
            return {"result": payload["result"]}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    finally:
        connection.close()


def fresh_moonraker_print_state(config: Config) -> str:
    """Return a freshly queried, recognized inactive state or ``unknown``.

    The Moonraker agent's long-lived connection carries subscriptions and may
    already have unread frames buffered by its event loop. Use a separate,
    bounded Unix-socket request here so a safety decision never consumes those
    frames or relies on the observational subscription cache.
    """
    payload = moonraker_rpc(
        config,
        "printer.objects.query",
        {"objects": {"print_stats": ["state"]}},
    )
    result = moonraker_result(payload)
    status = result.get("status") if isinstance(result, dict) else None
    print_stats = status.get("print_stats") if isinstance(status, dict) else None
    state = print_stats.get("state") if isinstance(print_stats, dict) else None
    normalized = state.strip().lower() if isinstance(state, str) else ""
    if normalized in MOONRAKER_CONFIG_MUTATION_STATES or normalized in {"printing", "paused"}:
        return normalized
    return "unknown"


def fresh_qidi_box_query_config(config: Config) -> str:
    """Return mcu_box1's configured serial path after a fresh shutdown check."""
    payload = moonraker_rpc(
        config,
        "printer.objects.query",
        {
            "objects": {
                "webhooks": ["state", "state_message"],
                "configfile": ["settings"],
            }
        },
    )
    result = moonraker_result(payload)
    status = result.get("status") if isinstance(result, dict) else None
    webhooks = status.get("webhooks") if isinstance(status, dict) else None
    state = webhooks.get("state") if isinstance(webhooks, dict) else None
    normalized_state = state.strip().lower() if isinstance(state, str) else "unknown"
    if normalized_state != "shutdown":
        raise CliError(
            "Box reset-reason query requires a fresh Moonraker Klipper state of shutdown "
            f"(got {normalized_state or 'unknown'})"
        )
    configfile = status.get("configfile") if isinstance(status, dict) else None
    settings = configfile.get("settings") if isinstance(configfile, dict) else None
    box_mcu = settings.get("mcu mcu_box1") if isinstance(settings, dict) else None
    if not isinstance(box_mcu, dict):
        raise CliError("Moonraker did not return structured settings for [mcu mcu_box1]")
    serial_path = box_mcu.get("serial")
    if not isinstance(serial_path, str) or not serial_path.strip():
        raise CliError("Moonraker did not return mcu_box1's configured serial path")
    if box_mcu.get("restart_method") != "command":
        raise CliError("mcu_box1 does not use the expected command restart method")
    return serial_path.strip()


def validate_qidi_box_usb_identity(by_id_name: str, identity: dict[str, str]) -> str:
    match = QIDI_BOX_BY_ID.fullmatch(by_id_name)
    if match is None:
        raise CliError("mcu_box1 is not configured with the supported QIDI Box 1.1.1 USB by-id endpoint")
    expected_serial = match.group(1)
    expected = {
        "vendor_id": "1d50",
        "product_id": "614e",
        "manufacturer": "Klipper",
        "product": "QIDI_BOX_V1_1.1.1",
        "serial": expected_serial,
    }
    for key, expected_value in expected.items():
        actual = identity.get(key, "")
        if actual != expected_value:
            raise CliError(
                f"mcu_box1 USB identity mismatch for {key}: expected {expected_value!r}, got {actual!r}"
            )
    return expected_serial


def resolve_qidi_box_endpoint(
    configured_serial: str,
    by_id_root: Path = Path("/dev/serial/by-id"),
    tty_root: Path = Path("/sys/class/tty"),
) -> dict[str, str]:
    configured = Path(configured_serial)
    if configured.parent != by_id_root or configured.name != configured_serial.rsplit("/", 1)[-1]:
        raise CliError("mcu_box1 serial must be a direct /dev/serial/by-id endpoint")
    if not configured.is_symlink():
        raise CliError(f"mcu_box1 configured serial is not a USB by-id symlink: {configured}")
    try:
        resolved = configured.resolve(strict=True)
        endpoint_stat = resolved.stat()
    except OSError as error:
        raise CliError(f"mcu_box1 USB endpoint is unavailable: {configured}") from error
    if resolved.parent != Path("/dev") or re.fullmatch(r"ttyACM[0-9]{1,4}", resolved.name) is None:
        raise CliError(f"mcu_box1 USB by-id path resolved to an unexpected endpoint: {resolved}")
    if not stat.S_ISCHR(endpoint_stat.st_mode):
        raise CliError(f"mcu_box1 USB endpoint is not a character device: {resolved}")
    try:
        tty_device = (tty_root / resolved.name / "device").resolve(strict=True)
    except OSError as error:
        raise CliError(f"could not resolve sysfs identity for {resolved}") from error
    usb_device = None
    for candidate in (tty_device,) + tuple(tty_device.parents):
        if USB_TOPOLOGY_PATH.fullmatch(candidate.name):
            usb_device = candidate
            break
    if usb_device is None:
        raise CliError(f"could not locate the USB device backing {resolved}")
    identity = {
        "vendor_id": diagnostic_system_text(usb_device / "idVendor", 16),
        "product_id": diagnostic_system_text(usb_device / "idProduct", 16),
        "manufacturer": diagnostic_system_text(usb_device / "manufacturer", 256),
        "product": diagnostic_system_text(usb_device / "product", 256),
        "serial": diagnostic_system_text(usb_device / "serial", 256),
    }
    validate_qidi_box_usb_identity(configured.name, identity)
    try:
        stable_resolution = configured.resolve(strict=True)
    except OSError as error:
        raise CliError("mcu_box1 USB endpoint disappeared during identity validation") from error
    if stable_resolution != resolved:
        raise CliError("mcu_box1 USB endpoint changed during identity validation")
    return {
        "configured": configured.as_posix(),
        "resolved": resolved.as_posix(),
        "vendor_id": identity["vendor_id"],
        "product_id": identity["product_id"],
        "manufacturer": identity["manufacturer"],
        "product": identity["product"],
        "serial": identity["serial"],
    }


def tty_live_process_owners(
    resolved_endpoint: Path,
    excluded_pids: set[int] | None = None,
    proc_root: Path = Path("/proc"),
) -> list[dict[str, Any]]:
    """Find live, non-deleted file descriptors for the current tty device."""
    excluded = excluded_pids or set()
    try:
        target_stat = resolved_endpoint.stat()
    except OSError as error:
        raise CliError(f"could not inspect mcu_box1 USB endpoint: {resolved_endpoint}") from error
    if not stat.S_ISCHR(target_stat.st_mode):
        raise CliError(f"mcu_box1 USB endpoint is not a character device: {resolved_endpoint}")
    if not proc_root.is_dir():
        raise CliError("/proc is required to verify exclusive access to the QIDI Box tty")
    owners = []
    try:
        processes = list(proc_root.iterdir())
    except OSError as error:
        raise CliError("could not inspect /proc for QIDI Box tty owners") from error
    for process in processes:
        if not process.name.isdigit():
            continue
        pid = int(process.name)
        if pid in excluded:
            continue
        try:
            descriptors = list((process / "fd").iterdir())
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                link_target = os.readlink(str(descriptor))
                descriptor_stat = descriptor.stat()
            except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
                continue
            if link_target.endswith(" (deleted)"):
                # A Klippy process may retain the dead tty from the disconnect;
                # it cannot exchange bytes with the newly enumerated tty.
                continue
            if not stat.S_ISCHR(descriptor_stat.st_mode) or descriptor_stat.st_rdev != target_stat.st_rdev:
                continue
            command = diagnostic_system_text(process / "comm", 128) or "unknown"
            owners.append({"pid": pid, "command": command})
            break
    return sorted(owners, key=lambda owner: owner["pid"])


def require_unowned_qidi_box_tty(endpoint: dict[str, str], excluded_pids: set[int] | None = None) -> None:
    owners = tty_live_process_owners(Path(endpoint["resolved"]), excluded_pids)
    if owners:
        details = ", ".join(f"{owner['pid']} ({owner['command']})" for owner in owners)
        raise CliError(f"refusing to share the QIDI Box tty with live process(es): {details}")


@contextlib.contextmanager
def qidi_box_query_lock() -> Iterable[None]:
    if os.name != "posix":
        raise CliError("Box reset-reason query requires a Linux printer host")
    import fcntl

    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = directory / "query-box-reset-reason.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(str(lock_path), flags, 0o600)
    except OSError as error:
        raise CliError("could not open the Box reset-reason query lock") from error
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise CliError("another Box reset-reason query is already running") from error
        yield
    finally:
        os.close(descriptor)


def validate_qidi_box_runtime_dictionary(message_parser: Any, expected_hash: str = QIDI_BOX_DICTIONARY_SHA256) -> dict[str, str]:
    version, _build_versions = message_parser.get_version_info()
    constants = message_parser.get_constants()
    mcu = constants.get("MCU") if isinstance(constants, dict) else None
    raw_dictionary = message_parser.get_raw_data_dictionary()
    if isinstance(raw_dictionary, str):
        raw_dictionary = raw_dictionary.encode("utf-8")
    if not isinstance(raw_dictionary, (bytes, bytearray)):
        raise CliError("QIDI Box returned an invalid runtime command dictionary")
    try:
        dictionary_payload = json.loads(bytes(raw_dictionary).decode("utf-8"))
        canonical_dictionary = json.dumps(
            dictionary_payload,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise CliError("QIDI Box returned an invalid runtime command dictionary") from error
    dictionary_hash = hashlib.sha256(canonical_dictionary).hexdigest()
    if version != QIDI_BOX_FIRMWARE_VERSION or mcu != QIDI_BOX_FIRMWARE_MCU:
        raise CliError(f"unsupported QIDI Box firmware identity: version={version!r}, mcu={mcu!r}")
    if dictionary_hash != expected_hash:
        raise CliError(
            "QIDI Box reports firmware 1.1.1, but its canonical runtime command contract "
            "does not match the analyzed 1.1.1 firmware"
        )
    messages = set(message_parser.get_messages())
    if (89, "command", QIDI_BOX_QUERY_COMMAND) not in messages:
        raise CliError("QIDI Box runtime dictionary has an unexpected reset-reason command")
    if (-2, "response", QIDI_BOX_QUERY_RESPONSE) not in messages:
        raise CliError("QIDI Box runtime dictionary has an unexpected reset-reason response")
    if (12, "command", QIDI_BOX_DEBUG_READ_COMMAND) not in messages:
        raise CliError("QIDI Box runtime dictionary has an unexpected debug-read command")
    if (-30, "response", QIDI_BOX_DEBUG_RESULT_RESPONSE) not in messages:
        raise CliError("QIDI Box runtime dictionary has an unexpected debug-read response")
    return {
        "version": version,
        "mcu": mcu,
        "dictionary_sha256": dictionary_hash,
    }


def decode_qidi_box_rcc_csr(raw_value: Any) -> dict[str, Any]:
    if isinstance(raw_value, bool) or not isinstance(raw_value, int) or not 0 <= raw_value <= 0xFFFFFFFF:
        raise CliError("QIDI Box returned an invalid RCC_CSR value")
    return {
        "register": "RCC_CSR",
        "address": f"0x{QIDI_BOX_RCC_CSR_ADDRESS:08X}",
        "raw": raw_value,
        "raw_hex": f"0x{raw_value:08X}",
        "asserted": [name for name, mask in QIDI_BOX_RESET_FLAG_MASKS if raw_value & mask],
    }


def query_qidi_box_reset_reason_session(
    serial_reader: Any,
    klipper_reactor: Any,
    expected_dictionary_hash: str = QIDI_BOX_DICTIONARY_SHA256,
) -> dict[str, Any]:
    message_parser = serial_reader.get_msgparser()
    firmware = validate_qidi_box_runtime_dictionary(message_parser, expected_dictionary_hash)
    command_queue = serial_reader.get_default_command_queue()

    # Read the sticky reset flags before reset_reason_get. This address and
    # width are fixed and firmware-gated; callers cannot use this path as an
    # arbitrary MCU memory reader. Reading RCC_CSR has no read-to-clear side
    # effect, and this session never writes RMVF.
    csr_command = message_parser.create_command(
        f"debug_read order={QIDI_BOX_RCC_CSR_ORDER} addr=0x{QIDI_BOX_RCC_CSR_ADDRESS:08X}"
    )
    csr_completion = klipper_reactor.completion()
    def complete_csr(response: dict[str, Any]) -> None:
        klipper_reactor.async_complete(csr_completion, response)

    serial_reader.register_response(complete_csr, "debug_result")
    try:
        serial_reader.raw_send_wait_ack(csr_command, 0, 0, command_queue)
        csr_response = csr_completion.wait(klipper_reactor.monotonic() + 1.0)
    finally:
        serial_reader.register_response(None, "debug_result")
    if not isinstance(csr_response, dict):
        raise CliError("QIDI Box returned no RCC_CSR debug-read response")
    rcc_csr = csr_response.get("val")
    decode_qidi_box_rcc_csr(rcc_csr)

    command = message_parser.create_command(
        f"reset_reason_get oid={QIDI_BOX_QUERY_OID}"
    )
    completion = klipper_reactor.completion()
    def complete_reason(response: dict[str, Any]) -> None:
        klipper_reactor.async_complete(completion, response)

    serial_reader.register_response(complete_reason, "reset_reason_return", QIDI_BOX_QUERY_OID)
    try:
        serial_reader.raw_send_wait_ack(
            command,
            0,
            0,
            command_queue,
        )
        response = completion.wait(klipper_reactor.monotonic() + 1.0)
    finally:
        serial_reader.register_response(None, "reset_reason_return", QIDI_BOX_QUERY_OID)
    if not isinstance(response, dict) or response.get("oid") != QIDI_BOX_QUERY_OID:
        raise CliError("QIDI Box returned no matching reset-reason response")
    raw_reason = response.get("reason")
    if isinstance(raw_reason, bytes):
        try:
            reason = raw_reason.decode("ascii", errors="strict")
        except UnicodeDecodeError as error:
            raise CliError("QIDI Box returned a non-ASCII reset reason") from error
    elif isinstance(raw_reason, str):
        reason = raw_reason
    else:
        raise CliError("QIDI Box returned an invalid reset reason")
    if reason not in QIDI_BOX_RESET_REASONS:
        raise CliError(f"QIDI Box returned an unknown reset reason: {reason!r}")
    return {**firmware, "reason": reason, "rcc_csr": rcc_csr}


def _query_qidi_box_reset_reason_transport(configured_serial: str, klippy_dir_text: str) -> dict[str, Any]:
    """Run one exclusive identify/query session; never issue reset or clocksync."""
    endpoint = resolve_qidi_box_endpoint(configured_serial)
    require_unowned_qidi_box_tty(endpoint)
    klippy_dir = Path(klippy_dir_text).resolve()
    expected_klippy_dir = (home_dir() / "klipper" / "klippy").resolve()
    if klippy_dir != expected_klippy_dir or not (klippy_dir / "serialhdl.py").is_file():
        raise CliError("refusing to load Klipper transport code from an unexpected path")
    sys.path.insert(0, str(klippy_dir))
    try:
        import reactor as klipper_reactor_module
        import serial as pyserial
        import serialhdl
    finally:
        try:
            sys.path.remove(str(klippy_dir))
        except ValueError:
            pass

    reactor_instance = klipper_reactor_module.Reactor()
    serial_reader = serialhdl.SerialReader(reactor_instance, warn_prefix="mcu_box1: ")
    outcome: dict[str, Any] = {}
    failures: list[Exception] = []

    def perform_query(_eventtime: float) -> float:
        serial_port = None
        try:
            require_unowned_qidi_box_tty(endpoint)
            serial_port = pyserial.Serial(
                baudrate=250000,
                timeout=0,
                write_timeout=1,
                exclusive=True,
                rtscts=False,
                dsrdtr=False,
            )
            serial_port.port = endpoint["resolved"]
            # Set stable asserted states before open. They are not toggled after
            # open, and the baud remains 250000 (never the 1200-baud boot hook).
            serial_port.rts = True
            serial_port.dtr = True
            serial_port.open()
            import fcntl as tty_fcntl
            import termios

            tty_fcntl.ioctl(serial_port.fileno(), termios.TIOCEXCL)
            if getattr(serial_port, "exclusive", None) is not True:
                raise CliError("QIDI Box tty did not retain exclusive-open mode")
            opened_stat = os.fstat(serial_port.fileno())
            current_stat = Path(endpoint["resolved"]).stat()
            if opened_stat.st_rdev != current_stat.st_rdev:
                raise CliError("QIDI Box tty changed while it was being opened")
            current_endpoint = resolve_qidi_box_endpoint(configured_serial)
            if current_endpoint != endpoint:
                raise CliError("QIDI Box USB identity changed while it was being opened")
            require_unowned_qidi_box_tty(endpoint, {os.getpid()})
            outcome["preconditions"] = dict(QIDI_BOX_TRANSPORT_PRECONDITIONS)
            # _start_session performs only the protocol identify exchange. It
            # deliberately bypasses connect_uart(), its bootloader probe, and
            # console.py's clocksync traffic.
            session_started = serial_reader._start_session(serial_port)
            if session_started is False:
                raise CliError("QIDI Box did not return a runtime command dictionary")
            serial_port = None  # SerialReader now owns and closes the handle.
            outcome.update(query_qidi_box_reset_reason_session(serial_reader, reactor_instance))
            outcome["endpoint"] = endpoint
        except Exception as error:
            failures.append(error)
        finally:
            try:
                serial_reader.disconnect()
            except Exception as error:
                if not failures:
                    failures.append(error)
            if serial_port is not None:
                try:
                    serial_port.close()
                except Exception:
                    pass
            reactor_instance.end()
        return reactor_instance.NEVER

    reactor_instance.register_callback(perform_query)
    try:
        reactor_instance.run()
    finally:
        reactor_instance.finalize()
    if failures:
        error = failures[0]
        if isinstance(error, CliError):
            raise error
        raise CliError(f"QIDI Box transport query failed: {error}") from error
    return outcome


def qidi_box_klipper_runtime() -> tuple[Path, Path]:
    interpreter = (home_dir() / "klippy-env" / "bin" / "python").resolve()
    klippy_dir = (home_dir() / "klipper" / "klippy").resolve()
    if not interpreter.is_file() or not os.access(str(interpreter), os.X_OK):
        raise CliError(f"Klipper Python interpreter not found: {interpreter}")
    if not (klippy_dir / "serialhdl.py").is_file() or not (klippy_dir / "reactor.py").is_file():
        raise CliError(f"Klipper Python transport modules not found: {klippy_dir}")
    return interpreter, klippy_dir


def run_qidi_box_reset_reason_transport(configured_serial: str) -> dict[str, Any]:
    interpreter, klippy_dir = qidi_box_klipper_runtime()
    module_path = Path(__file__).resolve()
    child_environment = {
        "HOME": str(home_dir()),
        "PATH": "/usr/bin:/bin",
        "PYTHONNOUSERSITE": "1",
    }
    try:
        process = subprocess.run(
            [
                str(interpreter),
                "-I",
                "-c",
                QIDI_BOX_TRANSPORT_BOOTSTRAP,
                str(module_path),
                configured_serial,
                str(klippy_dir),
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=8,
            env=child_environment,
        )
    except subprocess.TimeoutExpired as error:
        raise CliError("QIDI Box reset-reason transport query timed out without resetting the MCU") from error
    except OSError as error:
        raise CliError(f"could not start the bounded QIDI Box transport query: {error}") from error
    stdout = process.stdout.strip()
    if process.returncode != 0:
        detail_lines = [line.strip() for line in process.stderr.splitlines() if line.strip()]
        detail = detail_lines[-1][:500] if detail_lines else f"exit status {process.returncode}"
        raise CliError(f"QIDI Box reset-reason transport query failed: {detail}")
    if len(stdout.encode("utf-8")) > 16_384 or len(stdout.splitlines()) != 1:
        raise CliError("QIDI Box transport returned an invalid result envelope")
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise CliError("QIDI Box transport returned invalid JSON") from error
    if not isinstance(result, dict):
        raise CliError("QIDI Box transport returned an invalid result")
    return result


def build_qidi_box_reset_reason_result(
    transport: dict[str, Any],
    endpoint: dict[str, str],
) -> dict[str, Any]:
    reason = transport.get("reason")
    if reason not in QIDI_BOX_RESET_REASONS:
        raise CliError("QIDI Box transport result did not contain an allowlisted reset reason")
    reset_flags = decode_qidi_box_rcc_csr(transport.get("rcc_csr"))
    validated_firmware = {
        "version": transport.get("version"),
        "mcu": transport.get("mcu"),
        "dictionary_sha256": transport.get("dictionary_sha256"),
    }
    if validated_firmware != {
        **QIDI_BOX_FIRMWARE_IDENTITY,
        "dictionary_sha256": QIDI_BOX_DICTIONARY_SHA256,
    }:
        raise CliError("QIDI Box transport result did not preserve the validated firmware identity")
    if transport.get("endpoint") != endpoint:
        raise CliError("QIDI Box endpoint identity changed during the transport query")
    if transport.get("preconditions") != QIDI_BOX_TRANSPORT_PRECONDITIONS:
        raise CliError("QIDI Box transport did not preserve its exclusive-access proofs")
    return {
        "schema": QIDI_BOX_QUERY_SCHEMA,
        "target_mcu": "mcu_box1",
        "reason": reason,
        "reset_flags": reset_flags,
        "queried_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "firmware": dict(QIDI_BOX_FIRMWARE_IDENTITY),
        "endpoint": endpoint,
        "query": {name: dict(contract) for name, contract in QIDI_BOX_QUERY_CONTRACT.items()},
        "preconditions": dict(QIDI_BOX_PRECONDITIONS),
        "safety": dict(QIDI_BOX_SAFETY_CLAIMS),
        "caveat": QIDI_BOX_QUERY_CAVEAT,
    }


def validate_qidi_box_public_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict) or set(result) != {
        "schema",
        "target_mcu",
        "reason",
        "reset_flags",
        "queried_at",
        "firmware",
        "endpoint",
        "query",
        "preconditions",
        "safety",
        "caveat",
    }:
        raise CliError("query-box-reset-reason returned an invalid result schema")
    if result.get("schema") != QIDI_BOX_QUERY_SCHEMA or result.get("target_mcu") != "mcu_box1":
        raise CliError("query-box-reset-reason returned an unexpected schema or MCU")
    if result.get("reason") not in QIDI_BOX_RESET_REASONS:
        raise CliError("query-box-reset-reason returned an unknown reset reason")
    reset_flags = result.get("reset_flags")
    if not isinstance(reset_flags, dict) or set(reset_flags) != {
        "register",
        "address",
        "raw",
        "raw_hex",
        "asserted",
    }:
        raise CliError("query-box-reset-reason returned invalid raw reset flags")
    if reset_flags != decode_qidi_box_rcc_csr(reset_flags.get("raw")):
        raise CliError("query-box-reset-reason returned inconsistent raw reset flags")
    queried_at = result.get("queried_at")
    if not isinstance(queried_at, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", queried_at) is None:
        raise CliError("query-box-reset-reason returned an invalid timestamp")
    if result.get("firmware") != QIDI_BOX_FIRMWARE_IDENTITY:
        raise CliError("query-box-reset-reason returned an unexpected firmware identity")
    endpoint = result.get("endpoint")
    if not isinstance(endpoint, dict) or set(endpoint) != {
        "configured",
        "resolved",
        "vendor_id",
        "product_id",
        "manufacturer",
        "product",
        "serial",
    }:
        raise CliError("query-box-reset-reason returned an invalid endpoint identity")
    configured = endpoint.get("configured")
    if (
        not isinstance(configured, str)
        or Path(configured).parent != Path("/dev/serial/by-id")
        or Path(configured).as_posix() != configured
    ):
        raise CliError("query-box-reset-reason returned an invalid configured endpoint")
    validate_qidi_box_usb_identity(Path(configured).name, {
        key: value if isinstance(value, str) else ""
        for key, value in endpoint.items()
        if key in {"vendor_id", "product_id", "manufacturer", "product", "serial"}
    })
    resolved = endpoint.get("resolved")
    if not isinstance(resolved, str) or re.fullmatch(r"/dev/ttyACM[0-9]{1,4}", resolved) is None:
        raise CliError("query-box-reset-reason returned an invalid resolved endpoint")
    if result.get("query") != QIDI_BOX_QUERY_CONTRACT:
        raise CliError("query-box-reset-reason returned an unexpected query contract")
    if result.get("preconditions") != QIDI_BOX_PRECONDITIONS:
        raise CliError("query-box-reset-reason returned incomplete safety preconditions")
    if result.get("safety") != QIDI_BOX_SAFETY_CLAIMS:
        raise CliError("query-box-reset-reason returned unsafe or incomplete safety claims")
    if result.get("caveat") != QIDI_BOX_QUERY_CAVEAT:
        raise CliError("query-box-reset-reason returned an unexpected evidence caveat")
    return result


def cmd_query_box_reset_reason(args: list[str]) -> int:
    if args:
        raise CliError("query-box-reset-reason does not accept arguments")
    config = load_config()
    if config.client_mode != "printer":
        raise CliError("query-box-reset-reason is only available in printer mode")
    with qidi_box_query_lock():
        configured_serial = fresh_qidi_box_query_config(config)
        endpoint = resolve_qidi_box_endpoint(configured_serial)
        require_unowned_qidi_box_tty(endpoint)
        transport = run_qidi_box_reset_reason_transport(configured_serial)
        # Re-query Moonraker and the by-id mapping after the transport. A state
        # change or re-enumeration makes the evidence ambiguous, so fail closed.
        if fresh_qidi_box_query_config(config) != configured_serial:
            raise CliError("mcu_box1 configuration changed during the reset-reason query")
        if resolve_qidi_box_endpoint(configured_serial) != endpoint:
            raise CliError("mcu_box1 USB endpoint changed during the reset-reason query")
        result = validate_qidi_box_public_result(build_qidi_box_reset_reason_result(transport, endpoint))
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


def diagnostic_moonraker_request(
    config: Config,
    http_path: str,
    rpc_method: str,
    rpc_params: dict[str, Any] | None = None,
) -> Any:
    return moonraker_json(http_path) or moonraker_rpc(config, rpc_method, rpc_params)


def select_diagnostic_object_names(object_names: Any) -> list[str]:
    if not isinstance(object_names, list):
        return []
    base_objects = {
        "configfile",
        "display_status",
        "heaters",
        "print_stats",
        "system_stats",
        "toolhead",
        "virtual_sdcard",
        "webhooks",
    }
    prefixes = (
        "bed_mesh",
        "fan",
        "filament_",
        "heater",
        "mcu",
        "probe",
        "temperature_",
        "tmc",
    )
    return sorted({
        name
        for name in object_names
        if isinstance(name, str) and (name in base_objects or name.startswith(prefixes))
    })


def build_safe_save_variables_diagnostic(payload: Any) -> dict[str, Any]:
    result = moonraker_result(payload)
    status = result.get("status") if isinstance(result, dict) else None
    save_variables = status.get("save_variables") if isinstance(status, dict) else None
    variables = save_variables.get("variables") if isinstance(save_variables, dict) else None
    if not isinstance(variables, dict):
        raise CliError("Moonraker returned an invalid save_variables diagnostic snapshot")

    selected: dict[str, Any] = {}
    for name, value in variables.items():
        if not isinstance(name, str):
            continue
        if name in QIDI_BOX_BOOLEAN_DIAGNOSTIC_VARIABLES:
            if isinstance(value, bool) or (isinstance(value, int) and not isinstance(value, bool) and value in {0, 1}):
                selected[name] = value
        elif name in QIDI_BOX_INTEGER_DIAGNOSTIC_VARIABLES:
            if isinstance(value, int) and not isinstance(value, bool) and -128 <= value <= 128:
                selected[name] = value
        elif QIDI_BOX_SLOT_DIAGNOSTIC_VARIABLE.fullmatch(name):
            if isinstance(value, int) and not isinstance(value, bool) and -128 <= value <= 128:
                selected[name] = value
        elif name in {"last_load_slot", "slot_sync"}:
            if isinstance(value, str) and QIDI_BOX_SLOT_NAME.fullmatch(value):
                selected[name] = value
        elif name == "retry_step":
            if value is None or (isinstance(value, str) and QIDI_BOX_RETRY_STEP.fullmatch(value)):
                selected[name] = value
    return {
        "schema": "klippee-safe-save-variables/v1",
        "variables": dict(sorted(selected.items())),
        "omitted_variable_count": max(0, len(variables) - len(selected)),
    }


def collect_moonraker_diagnostics(config: Config) -> tuple[list[tuple[str, bytes, str]], list[str]]:
    artifacts: list[tuple[str, bytes, str]] = []
    warnings: list[str] = []
    server = diagnostic_moonraker_request(config, "/server/info", "server.info")
    if not server:
        return artifacts, ["Moonraker API was unavailable; runtime snapshots were not collected."]

    endpoints = [
        ("snapshots/server-info.json", server, "moonraker-snapshot"),
        (
            "snapshots/printer-info.json",
            diagnostic_moonraker_request(config, "/printer/info", "printer.info"),
            "moonraker-snapshot",
        ),
        (
            "snapshots/temperature-store.json",
            diagnostic_moonraker_request(config, "/server/temperature_store", "server.temperature_store"),
            "moonraker-snapshot",
        ),
        (
            "snapshots/gcode-store.json",
            diagnostic_moonraker_request(
                config,
                "/server/gcode_store?count=1000",
                "server.gcode_store",
                {"count": 1000},
            ),
            "moonraker-snapshot",
        ),
        (
            "snapshots/job-history.json",
            diagnostic_moonraker_request(
                config,
                "/server/history/list?limit=20&order=desc",
                "server.history.list",
                {"limit": 20, "order": "desc"},
            ),
            "moonraker-snapshot",
        ),
        (
            "snapshots/system-info.json",
            diagnostic_moonraker_request(config, "/machine/system_info", "machine.system_info"),
            "system-snapshot",
        ),
        (
            "snapshots/process-stats.json",
            diagnostic_moonraker_request(config, "/machine/proc_stats", "machine.proc_stats"),
            "system-snapshot",
        ),
    ]
    objects_payload = diagnostic_moonraker_request(
        config,
        "/printer/objects/list",
        "printer.objects.list",
    )
    endpoints.append(("snapshots/printer-objects-list.json", objects_payload, "moonraker-snapshot"))
    available = moonraker_result(objects_payload)
    object_names = available.get("objects") if isinstance(available, dict) else None
    selected = select_diagnostic_object_names(object_names)
    if selected:
        endpoints.append((
            "snapshots/printer-objects.json",
            diagnostic_moonraker_request(
                config,
                diagnostic_object_query(selected),
                "printer.objects.query",
                {"objects": {name: None for name in selected}},
            ),
            "moonraker-snapshot",
        ))
    if isinstance(object_names, list) and "save_variables" in object_names:
        save_variables_payload = diagnostic_moonraker_request(
            config,
            diagnostic_object_query(["save_variables"]),
            "printer.objects.query",
            {"objects": {"save_variables": None}},
        )
        if save_variables_payload:
            try:
                safe_save_variables = build_safe_save_variables_diagnostic(save_variables_payload)
            except CliError as error:
                warnings.append(f"snapshots/save-variables.json was unavailable: {error}")
            else:
                endpoints.append((
                    "snapshots/save-variables.json",
                    safe_save_variables,
                    "moonraker-snapshot",
                ))

    for name, payload, kind in endpoints:
        if not payload:
            warnings.append(f"{name} was unavailable.")
            continue
        artifacts.append((name, diagnostic_json(payload), kind))
    return artifacts, warnings


def collect_command_diagnostic(command: list[str]) -> tuple[bytes | None, bool]:
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(
                command,
                stdout=output,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=8,
            )
        except (OSError, subprocess.SubprocessError):
            return None, False
        size = output.tell()
        if result.returncode != 0 or size <= 0:
            return None, False
        truncated = size > MAX_DIAGNOSTIC_COMMAND_BYTES
        output.seek(max(0, size - MAX_DIAGNOSTIC_COMMAND_BYTES))
        content = output.read()
        if truncated:
            first_line = content.find(b"\n")
            if first_line >= 0:
                content = content[first_line + 1:]
        return content if content.strip() else None, truncated


def collect_journal_diagnostics() -> tuple[list[tuple[str, bytes, str, bool]], list[str]]:
    journalctl = resolve_program("journalctl")
    if journalctl is None:
        return [], ["journalctl was unavailable; service and kernel excerpts were not collected."]
    commands = [
        (
            "logs/services-journal.log",
            [journalctl, "--no-pager", "--output=short-iso", "--lines=2000", "-u", "klipper", "-u", "moonraker"],
        ),
        (
            "logs/user-services-journal.log",
            [journalctl, "--user", "--no-pager", "--output=short-iso", "--lines=2000", "-u", "klipper", "-u", "moonraker"],
        ),
        (
            "logs/kernel-journal.log",
            [journalctl, "--dmesg", "--no-pager", "--output=short-iso", "--lines=1500"],
        ),
    ]
    artifacts: list[tuple[str, bytes, str, bool]] = []
    for name, command in commands:
        content, truncated = collect_command_diagnostic(command)
        if content:
            artifacts.append((name, content, "journal", truncated))
    if not artifacts:
        return [], ["No readable Klipper, Moonraker, or kernel journal excerpts were found."]
    return artifacts, []


def diagnostic_log_entry(
    source: Path,
    archive_name: str,
    maximum_bytes: int,
) -> tuple[dict[str, Any], int, int]:
    try:
        source_size = source.stat().st_size
    except OSError as error:
        raise CliError(f"could not read diagnostic log {source}: {error}") from error
    if source_size <= 0:
        raise CliError(f"diagnostic log is empty: {source}")
    truncated = source_size > maximum_bytes and source.suffix.lower() != ".gz"
    stored_size = min(source_size, maximum_bytes) if truncated else source_size
    return {
        "archiveName": archive_name,
        "kind": "klippy-log" if "klippy" in source.name.lower() else "moonraker-log",
        "originalSizeBytes": source_size,
        "source": source,
        "storedSizeBytes": stored_size,
        "truncated": truncated,
    }, source_size, stored_size


def write_log_to_bundle(archive: zipfile.ZipFile, artifact: dict[str, Any]) -> None:
    source = artifact["source"]
    archive_name = artifact["archiveName"]
    with archive.open(archive_name, "w") as output_file:
        with source.open("rb") as input_file:
            if artifact["truncated"]:
                input_file.seek(artifact["originalSizeBytes"] - artifact["storedSizeBytes"])
                input_file.readline()
            shutil.copyfileobj(input_file, output_file, length=1024 * 1024)


def prepare_diagnostic_bundle(
    config: Config,
    source: Path,
) -> tuple[Path, str, int, bool, int, list[str]]:
    handle = tempfile.NamedTemporaryFile(prefix="klippee-diagnostic-", suffix=".zip", delete=False)
    bundle = Path(handle.name)
    handle.close()
    artifacts: list[dict[str, Any]] = []
    warnings: list[str] = []
    original_size = 0
    any_truncated = False

    primary_name = "logs/klippy.log.gz" if source.suffix.lower() == ".gz" else "logs/klippy.log"
    primary, source_size, _ = diagnostic_log_entry(source, primary_name, MAX_DIAGNOSTIC_SOURCE_BYTES)
    artifacts.append(primary)
    original_size += source_size
    any_truncated = primary["truncated"]

    moonraker_log = source.parent / "moonraker.log"
    if moonraker_log.is_file() and moonraker_log.resolve() != source.resolve():
        supporting, support_size, _ = diagnostic_log_entry(
            moonraker_log,
            "logs/moonraker.log",
            MAX_DIAGNOSTIC_SUPPORT_LOG_BYTES,
        )
        artifacts.append(supporting)
        original_size += support_size
        any_truncated = any_truncated or supporting["truncated"]
    else:
        warnings.append("moonraker.log was not found beside the Klippy log.")

    moonraker_artifacts, moonraker_warnings = collect_moonraker_diagnostics(config)
    warnings.extend(moonraker_warnings)
    journal_artifacts, journal_warnings = collect_journal_diagnostics()
    warnings.extend(journal_warnings)
    host_info = diagnostic_json({
        **collect_host_info(config),
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pythonVersion": platform.python_version(),
    })
    host_scheduling = diagnostic_json(collect_host_scheduling_info())
    usb_serial_topology = diagnostic_json(collect_usb_serial_topology())
    memory_artifacts = [
        ("snapshots/host-info.json", host_info, "system-snapshot", False),
        ("snapshots/host-scheduling.json", host_scheduling, "system-snapshot", False),
        ("snapshots/usb-serial-topology.json", usb_serial_topology, "system-snapshot", False),
        *[(name, content, kind, False) for name, content, kind in moonraker_artifacts],
        *journal_artifacts,
    ]
    for _, content, _, truncated in memory_artifacts:
        original_size += len(content)
        any_truncated = any_truncated or truncated

    generated_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    file_name = f"klippee-diagnostics-{generated_at.replace(':', '').replace('-', '')}.zip"
    try:
        with zipfile.ZipFile(
            str(bundle),
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=False,
        ) as archive:
            manifest_artifacts: list[dict[str, Any]] = []
            for artifact in artifacts:
                write_log_to_bundle(archive, artifact)
                manifest_artifacts.append({
                    key: artifact[key]
                    for key in ("archiveName", "kind", "originalSizeBytes", "storedSizeBytes", "truncated")
                })
            for name, content, kind, truncated in memory_artifacts:
                archive.writestr(name, content)
                manifest_artifacts.append({
                    "archiveName": name,
                    "kind": kind,
                    "originalSizeBytes": len(content),
                    "storedSizeBytes": len(content),
                    "truncated": truncated,
                })
            archive.writestr("manifest.json", diagnostic_json({
                "artifacts": manifest_artifacts,
                "client": {
                    "mode": config.client_mode,
                    "repositoryId": config.repository_id,
                    "version": CLI_VERSION,
                },
                "collectionWarnings": warnings,
                "generatedAt": generated_at,
                "schema": "https://klippee.xyz/schemas/diagnostic-bundle-v2.json",
                "schemaVersion": DIAGNOSTIC_BUNDLE_VERSION,
            }))
        if bundle.stat().st_size > MAX_DIAGNOSTIC_UPLOAD_BYTES:
            raise CliError("compressed diagnostic bundle exceeds the 16 MiB upload limit")
        return bundle, file_name, original_size, any_truncated, len(artifacts) + len(memory_artifacts), warnings
    except Exception:
        unlink_if_exists(bundle)
        raise


def cmd_upload_diagnostics(args: list[str]) -> int:
    if len(args) > 1:
        raise CliError("upload-diagnostics accepts at most one log path")
    config = load_config()
    if config.client_mode != "printer":
        raise CliError("upload-diagnostics is only available in printer mode")
    source = Path(args[0]).expanduser() if args else default_diagnostic_log(config)
    if not source.is_file():
        raise CliError(f"diagnostic log not found: {source}")

    upload, file_name, original_size, truncated, artifact_count, warnings = prepare_diagnostic_bundle(config, source)
    url = f"{config.base_url}/api/sync/repos/{config.repository_id}/diagnostics"
    print(f"klippee: preparing {source}")
    if truncated:
        print("klippee: one or more diagnostic sources were truncated to their newest useful data")
    print(f"klippee: collected {artifact_count} diagnostic artifacts")
    for warning in warnings:
        print(f"klippee: warning: {warning}")
    try:
        status, body = run_curl(
            url,
            method="POST",
            headers=[
                "Content-Type: application/zip",
                f"X-Klippee-Log-Name: {file_name}",
                f"X-Klippee-Original-Size: {original_size}",
                f"X-Klippee-Truncated: {1 if truncated else 0}",
            ],
            data_path=upload,
            token=config.token,
            failure_message=f"could not upload diagnostics to {url}",
        )
        raw = body.decode("utf-8", errors="replace")
        if not 200 <= status < 300:
            detail = raw.strip()
            raise CliError(f"diagnostic upload failed with HTTP {status}{f': {detail}' if detail else ''}")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise CliError("diagnostic upload returned invalid JSON") from error
        diagnostics_url = payload.get("url") if isinstance(payload, dict) else None
        if not isinstance(diagnostics_url, str) or not diagnostics_url:
            raise CliError("diagnostic upload response did not include its private URL")
        print("klippee: diagnostic bundle uploaded privately for 48 hours")
        print(f"klippee: open {diagnostics_url}")
        print("klippee: DIAGNOSTIC UPLOAD SUCCESSFUL")
        return 0
    finally:
        unlink_if_exists(upload)


def moonraker_socket_path(config: Config) -> Path:
    configured = os.environ.get("KLIPPEE_MOONRAKER_SOCKET")
    if configured:
        return Path(configured).expanduser()
    return config.config_dir.parent / "comms" / "moonraker.sock"


def systemd_quote(value: str | Path) -> str:
    escaped = str(value).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def systemctl_command() -> list[str]:
    override = os.environ.get("KLIPPEE_SYSTEMCTL_COMMAND")
    if override:
        try:
            command = json.loads(override)
        except json.JSONDecodeError as error:
            raise CliError("KLIPPEE_SYSTEMCTL_COMMAND must be a JSON array") from error
        if not isinstance(command, list) or not command or not all(isinstance(part, str) and part for part in command):
            raise CliError("KLIPPEE_SYSTEMCTL_COMMAND must be a non-empty JSON string array")
        resolved = resolve_program(command[0]) if Path(command[0]).name == command[0] else command[0]
        if not resolved or not Path(resolved).is_absolute():
            raise CliError("KLIPPEE_SYSTEMCTL_COMMAND must start with an absolute or trusted PATH executable")
        return [resolved, *command[1:]]
    return [require_program("systemctl")]


def moonraker_agent_unit_path() -> Path:
    return home_dir() / ".config" / "systemd" / "user" / MOONRAKER_AGENT_UNIT_NAME


def config_has_section(config: Config, section: str, excluded_paths: set[str] | None = None) -> bool:
    section_pattern = re.compile(rf"^\s*\[{re.escape(section)}\]\s*(?:#.*)?$", re.IGNORECASE | re.MULTILINE)
    for relative in config_files(config.config_dir):
        if excluded_paths and relative in excluded_paths:
            continue
        try:
            if section_pattern.search((config.config_dir / relative).read_text(encoding="utf-8", errors="replace")):
                return True
        except OSError:
            continue
    return False


def moonraker_macros(include_respond: bool) -> str:
    respond_section = "[respond]\n\n" if include_respond else ""
    return (
        f"{MOONRAKER_MACRO_MARKER}\n"
        "# These macros appear automatically in Mainsail and Fluidd.\n\n"
        f"{respond_section}"
        "[gcode_macro KLIPPEE_CHECK]\n"
        "description: Check this printer against its desired configuration\n"
        "gcode:\n"
        "  {action_respond_info(\"Klippee configuration check requested\")}\n"
        "  {action_call_remote_method(\"klippee_check\")}\n\n"
        "[gcode_macro KLIPPEE_CAPTURE]\n"
        "description: Keep this printer's current configuration\n"
        "gcode:\n"
        "  {action_respond_info(\"Klippee capture requested\")}\n"
        "  {action_call_remote_method(\"klippee_capture\")}\n\n"
        "[gcode_macro KLIPPEE_APPLY]\n"
        "description: Apply the desired configuration to this printer\n"
        "gcode:\n"
        "  {action_respond_info(\"Klippee apply requested; Klipper will not restart automatically\")}\n"
        "  {action_call_remote_method(\"klippee_apply\")}\n\n"
        "[gcode_macro KLIPPEE_UPLOAD_DIAGNOSTICS]\n"
        "description: Upload a private diagnostic bundle to Klippee\n"
        "gcode:\n"
        "  {action_respond_info(\"Klippee diagnostic upload requested\")}\n"
        "  {action_call_remote_method(\"klippee_upload_diagnostics\")}\n"
    )


class MoonrakerAgent:
    def __init__(self, config: Config, socket_path: Path, executable: Path):
        self.config = config
        self.socket_path = socket_path
        self.executable = executable
        self.connection: socket.socket | None = None
        self.send_lock = threading.Lock()
        self.command_lock = threading.Lock()
        self.operation_lock = threading.Lock()
        self.request_id_lock = threading.Lock()
        self.print_state = "unknown"
        self.next_request_id = 0
        self.setup_request_ids: set[int] = set()
        self.current_operation: dict[str, Any] | None = None
        self.last_operation: dict[str, Any] | None = None

    def allocate_request_id(self) -> int:
        with self.request_id_lock:
            self.next_request_id += 1
            return self.next_request_id

    def operation_timestamp(self) -> str:
        return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def begin_operation(self, method: str) -> dict[str, Any]:
        operation = {
            "id": uuid.uuid4().hex,
            "method": method,
            "command": MOONRAKER_AGENT_METHODS[method][0],
            "status": "running",
            "started_at": self.operation_timestamp(),
        }
        with self.operation_lock:
            self.current_operation = operation
        return dict(operation)

    def complete_operation(
        self,
        operation_id: str,
        status: str,
        summary: str,
        return_code: int | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        with self.operation_lock:
            current = self.current_operation
            if current is None or current.get("id") != operation_id:
                return
            completed = dict(current)
            completed.update(
                {
                    "status": status,
                    "completed_at": self.operation_timestamp(),
                    "return_code": return_code,
                    "summary": summary[:2000],
                }
            )
            if result is not None:
                completed["result"] = result
            self.current_operation = None
            self.last_operation = completed

    def operation_status(self, operation_id: str | None = None) -> dict[str, Any]:
        with self.operation_lock:
            current = dict(self.current_operation) if self.current_operation is not None else None
            last = dict(self.last_operation) if self.last_operation is not None else None
        if operation_id is not None:
            current = current if current is not None and current.get("id") == operation_id else None
            last = last if last is not None and last.get("id") == operation_id else None
        operation = current or last
        return {
            "running": current is not None,
            "found": operation is not None,
            "operation_id": operation_id or (operation.get("id") if operation is not None else None),
            "current": current,
            "last_result": last,
        }

    def send(self, method: str, params: dict[str, Any] | None = None, request_id: int | None = None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if request_id is not None:
            payload["id"] = request_id
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8") + ETX
        with self.send_lock:
            if self.connection is None:
                raise OSError("Moonraker is not connected")
            self.connection.sendall(encoded)

    def respond(self, request_id: Any, result: Any = None, error: str | None = None) -> None:
        if request_id is None:
            return
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if error is None:
            payload["result"] = result
        else:
            payload["error"] = {"code": -32000, "message": error}
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8") + ETX
        with self.send_lock:
            if self.connection is not None:
                self.connection.sendall(encoded)

    def update_print_state(self, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        status = payload.get("status", payload)
        print_stats = status.get("print_stats") if isinstance(status, dict) else None
        state = print_stats.get("state") if isinstance(print_stats, dict) else None
        if isinstance(state, str):
            self.print_state = state.lower()

    def report(self, message: str) -> None:
        cleaned = " ".join(message.replace('"', "'").split())[:500]
        print(f"klippee-agent: {cleaned}", flush=True)
        try:
            self.send(
                "printer.gcode.script",
                {"script": f'RESPOND TYPE=echo MSG="Klippee: {cleaned}"'},
                self.allocate_request_id(),
            )
        except OSError:
            pass

    def run_cli(self, method: str, operation_id: str) -> None:
        command = MOONRAKER_AGENT_METHODS[method]
        status = "failed"
        return_code: int | None = None
        summary = f"{command[0]} failed"
        structured_result: dict[str, Any] | None = None

        def report_operation(message: str) -> None:
            if command[0] == "query-box-reset-reason":
                # Klippy is required to be shutdown for this operation. Keep
                # the agent transport entirely in Moonraker and do not attempt
                # a G-code response on the unavailable Klippy connection.
                print(f"klippee-agent: {' '.join(message.split())[:500]}", flush=True)
            else:
                self.report(message)

        try:
            report_operation(f"{command[0]} started")
            result = subprocess.run(
                [sys.executable, str(self.executable), *command],
                text=True,
                capture_output=True,
                check=False,
                timeout=180,
            )
            return_code = result.returncode
            output_lines = [line.strip() for line in f"{result.stdout}\n{result.stderr}".splitlines() if line.strip()]
            summary = " | ".join(output_lines[-4:]) or f"{command[0]} finished"
            if result.returncode == 0:
                if command[0] == "query-box-reset-reason":
                    if result.stderr.strip() or len(result.stdout.encode("utf-8")) > 16_384:
                        raise CliError("query-box-reset-reason returned an invalid result envelope")
                    json_lines = [line for line in result.stdout.splitlines() if line.strip()]
                    if len(json_lines) != 1:
                        raise CliError("query-box-reset-reason did not return exactly one JSON result")
                    try:
                        parsed_result = json.loads(json_lines[0])
                    except json.JSONDecodeError as error:
                        raise CliError("query-box-reset-reason returned invalid JSON") from error
                    structured_result = validate_qidi_box_public_result(parsed_result)
                    asserted = structured_result["reset_flags"]["asserted"]
                    asserted_text = ", ".join(asserted) if asserted else "none"
                    summary = (
                        f"QIDI Box reset reason: {structured_result['reason']}; "
                        f"RCC_CSR {structured_result['reset_flags']['raw_hex']} "
                        f"({asserted_text}); "
                        "flags were not cleared and the result may be stale"
                    )
                status = "succeeded"
                report_operation(summary)
            else:
                report_operation(f"{command[0]} failed: {summary}")
        except subprocess.TimeoutExpired:
            status = "timed_out"
            summary = "command timed out"
            report_operation(f"{command[0]} failed: {summary}")
        except CliError as error:
            status = "failed"
            summary = str(error)
            if return_code == 0:
                return_code = 1
            report_operation(f"{command[0]} failed: {summary}")
        except OSError as error:
            summary = str(error)
            report_operation(f"{command[0]} failed: {summary}")
        except Exception as error:
            summary = f"unexpected error: {error}"
            report_operation(f"{command[0]} failed: {summary}")
        finally:
            self.complete_operation(operation_id, status, summary, return_code, structured_result)
            self.command_lock.release()

    def handle_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        request_id = message.get("id")
        if request_id in self.setup_request_ids and "error" in message:
            error = message.get("error")
            detail = error.get("message") if isinstance(error, dict) else str(error)
            raise OSError(f"Moonraker rejected agent setup: {detail}")
        method = message.get("method")
        if method == "notify_status_update":
            params = message.get("params")
            if isinstance(params, list) and params:
                self.update_print_state(params[0])
            return
        if method == MOONRAKER_OPERATION_STATUS_METHOD:
            params = message.get("params")
            operation_id = None
            if isinstance(params, dict) and "operation_id" in params:
                candidate = params.get("operation_id")
                if not isinstance(candidate, str) or not candidate.strip() or len(candidate) > 128:
                    self.respond(request_id, error="operation_id must be a non-empty string of at most 128 characters")
                    return
                operation_id = candidate
            self.respond(request_id, self.operation_status(operation_id))
            return
        if method not in MOONRAKER_AGENT_METHODS:
            return
        command_name = MOONRAKER_AGENT_METHODS[method][0]
        if command_name in {"apply", "capture"}:
            print_state = fresh_moonraker_print_state(self.config)
            if print_state not in MOONRAKER_CONFIG_MUTATION_STATES:
                detail = f"{command_name} blocked while fresh printer state is {print_state}"
                self.respond(request_id, error=detail)
                self.report(detail)
                return
        if not self.command_lock.acquire(blocking=False):
            detail = "another Klippee command is already running"
            self.respond(request_id, error=detail)
            self.report(detail)
            return
        operation = self.begin_operation(method)
        try:
            worker = threading.Thread(target=self.run_cli, args=(method, operation["id"]), daemon=True)
            worker.start()
        except Exception as error:
            detail = f"could not start {command_name}: {error}"
            self.complete_operation(operation["id"], "failed", detail)
            self.command_lock.release()
            self.respond(request_id, error=detail)
            self.report(detail)
            return
        self.respond(
            request_id,
            {"accepted": True, "command": command_name, "operation_id": operation["id"]},
        )

    def receive_message(self, connection: socket.socket, pending: bytes) -> tuple[dict[str, Any], bytes]:
        while True:
            # The bounded buffer raises OSError on an unterminated stream so
            # run_forever's reconnect loop replaces the connection.
            raw, pending = read_etx_frame(connection.recv, pending, MAX_DIAGNOSTIC_SNAPSHOT_BYTES)
            try:
                message = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                print(f"klippee-agent: ignored invalid Moonraker message: {error}", flush=True)
                continue
            if isinstance(message, dict):
                return message, pending

    def wait_for_response(
        self,
        connection: socket.socket,
        request_id: int,
        pending: bytes,
        update_print_state: bool = False,
    ) -> bytes:
        while True:
            message, pending = self.receive_message(connection, pending)
            if message.get("id") != request_id:
                self.handle_message(message)
                continue
            if "error" in message:
                error = message.get("error")
                detail = error.get("message") if isinstance(error, dict) else str(error)
                raise OSError(f"Moonraker rejected agent setup: {detail}")
            if update_print_state:
                self.update_print_state(message.get("result"))
            return pending

    def setup_request(
        self,
        connection: socket.socket,
        pending: bytes,
        method: str,
        params: dict[str, Any],
        update_print_state: bool = False,
    ) -> bytes:
        request_id = self.allocate_request_id()
        self.setup_request_ids.add(request_id)
        self.send(method, params, request_id)
        return self.wait_for_response(connection, request_id, pending, update_print_state)

    def initialize_connection(self, connection: socket.socket) -> bytes:
        pending = b""
        self.setup_request_ids.clear()
        pending = self.setup_request(
            connection,
            pending,
            "server.connection.identify",
            {
                "client_name": "klippee",
                "version": CLI_VERSION,
                "type": "agent",
                "url": "https://klippee.xyz",
            },
        )
        for method in MOONRAKER_KLIPPER_REMOTE_METHODS:
            pending = self.setup_request(
                connection,
                pending,
                "connection.register_remote_method",
                {"method_name": method},
            )
        pending = self.setup_request(
            connection,
            pending,
            "printer.objects.subscribe",
            {"objects": {"print_stats": ["state"]}},
            update_print_state=True,
        )
        return pending

    def connected_loop(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(str(self.socket_path))
        self.connection = connection
        try:
            pending = self.initialize_connection(connection)
            self.report("Moonraker agent connected")
            while True:
                message, pending = self.receive_message(connection, pending)
                self.handle_message(message)
        finally:
            self.connection = None
            connection.close()

    def run_forever(self) -> None:
        while True:
            try:
                self.connected_loop()
            except OSError as error:
                print(f"klippee-agent: Moonraker unavailable at {self.socket_path}: {error}; retrying", flush=True)
                time.sleep(5)


def cmd_moonraker_agent(args: list[str]) -> int:
    if args:
        raise CliError("moonraker-agent does not accept arguments")
    config = load_config()
    if config.client_mode != "printer":
        raise CliError("moonraker-agent is only available in printer mode")
    MoonrakerAgent(config, moonraker_socket_path(config), Path(sys.argv[0]).resolve()).run_forever()
    return 0


def cmd_install_moonraker(args: list[str]) -> int:
    if args:
        raise CliError("install-moonraker does not accept arguments")
    config = load_config()
    if config.client_mode != "printer":
        raise CliError("install-moonraker is only available in printer mode")
    systemctl = systemctl_command()
    socket_path = moonraker_socket_path(config)
    if not socket_path.exists():
        raise CliError(
            f"Moonraker socket not found: {socket_path}\n"
            "set KLIPPEE_MOONRAKER_SOCKET to the correct moonraker.sock path and retry"
        )
    printer_config = config.config_dir / "printer.cfg"
    if not printer_config.is_file():
        raise CliError(f"printer.cfg not found in {config.config_dir}")

    macros_path = config.config_dir / "klippee-macros.cfg"
    if macros_path.exists() and MOONRAKER_MACRO_MARKER not in macros_path.read_text(encoding="utf-8", errors="replace"):
        raise CliError(f"refusing to overwrite unmanaged macro file: {macros_path}")
    write_atomic_text(
        macros_path,
        moonraker_macros(not config_has_section(config, "respond", {"klippee-macros.cfg"})),
    )

    printer_text = printer_config.read_text(encoding="utf-8")
    include_pattern = re.compile(r"^\s*\[include\s+klippee-macros\.cfg\]\s*(?:#.*)?$", re.IGNORECASE | re.MULTILINE)
    backup: Path | None = None
    if include_pattern.search(printer_text) is None:
        backup = backup_config_dir(config)
        separator = "" if not printer_text or printer_text.endswith("\n") else "\n"
        write_atomic_text(printer_config, f"{printer_text}{separator}\n[include klippee-macros.cfg]\n")

    executable = Path(sys.argv[0]).resolve()
    unit = moonraker_agent_unit_path()
    unit_content = (
        "[Unit]\n"
        f"{MOONRAKER_AGENT_UNIT_MARKER}\n"
        "After=network-online.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"ExecStart={systemd_quote(sys.executable)} {systemd_quote(executable)} moonraker-agent\n"
        f"Environment={systemd_quote(f'KLIPPEE_MOONRAKER_SOCKET={socket_path}')}\n"
        f"Environment={systemd_quote(f'KLIPPEE_STATE_DIR={state_dir()}')}\n"
        "Restart=on-failure\n"
        "RestartSec=5\n\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )
    write_atomic_text(unit, unit_content)
    try:
        subprocess.run([*systemctl, "--user", "daemon-reload"], check=True)
        subprocess.run([*systemctl, "--user", "enable", unit.name], check=True)
        subprocess.run([*systemctl, "--user", "restart", unit.name], check=True)
    except subprocess.CalledProcessError as error:
        raise CliError(f"could not enable {unit.name} with systemd") from error

    print(f"klippee: installed Moonraker agent service at {unit}")
    print(f"klippee: installed Mainsail/Fluidd macros at {macros_path}")
    if backup is not None:
        print(f"klippee: previous printer config backed up to {backup}")
    print("klippee: restart Klipper once to load KLIPPEE_CHECK, KLIPPEE_CAPTURE, and KLIPPEE_APPLY")
    print("klippee: the integration will never restart Klipper automatically")
    return 0


def cmd_install_timer(_args: list[str]) -> int:
    config = load_config()
    if config.client_mode == "desktop":
        raise CliError("install-timer is only available in printer mode")
    systemctl = systemctl_command()
    executable = Path(sys.argv[0]).resolve()
    unit_dir = home_dir() / ".config" / "systemd" / "user"
    write_atomic_text(
        unit_dir / "klippee-sync.service",
        "[Unit]\nDescription=Klippee printer config sync\n\n"
        "[Service]\nType=oneshot\n"
        f"ExecStart={systemd_quote(executable)} check\n",
    )
    write_atomic_text(
        unit_dir / "klippee-sync.timer",
        "[Unit]\nDescription=Run Klippee printer config sync\n\n"
        "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=10min\nPersistent=true\n\n"
        "[Install]\nWantedBy=timers.target\n",
    )
    try:
        subprocess.run([*systemctl, "--user", "daemon-reload"], check=True)
        subprocess.run([*systemctl, "--user", "enable", "--now", "klippee-sync.timer"], check=True)
    except subprocess.CalledProcessError as error:
        raise CliError("could not enable klippee-sync.timer with systemd") from error
    print("klippee: read-only status timer installed")
    return 0


def trusted_artifact_base_url(environment_name: str, insecure_flag: str, purpose: str) -> str:
    """Return an explicitly trusted artifact origin, never workspace state."""
    base_url = os.environ.get(environment_name, OFFICIAL_UPGRADE_BASE_URL).rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    insecure_loopback = (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
        and os.environ.get(insecure_flag) == "1"
    )
    if (
        (parsed.scheme != "https" and not insecure_loopback)
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise CliError(
            f"{purpose} source must be a trusted HTTPS origin; "
            f"use {environment_name} only for an explicitly trusted mirror"
        )
    return base_url


def upgrade_base_url() -> str:
    return trusted_artifact_base_url(
        "KLIPPEE_UPGRADE_BASE_URL",
        "KLIPPEE_ALLOW_INSECURE_UPGRADE",
        "upgrade",
    )


def install_base_url() -> str:
    return trusted_artifact_base_url(
        "KLIPPEE_INSTALL_BASE_URL",
        "KLIPPEE_ALLOW_INSECURE_INSTALL",
        "install",
    )


def cli_version_key(value: str) -> tuple[int, ...]:
    if re.fullmatch(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?", value) is None:
        raise CliError(f"invalid Klippee CLI version: {value}")
    return tuple(int(part) for part in value.split("."))


def validate_cli_source(source: bytes, source_url: str) -> tuple[str, str]:
    if not source or len(source) > MAX_CLI_BYTES:
        raise CliError(f"downloaded CLI from {source_url} has an invalid size")
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CliError(f"downloaded CLI from {source_url} is not UTF-8") from error
    if CLI_SOURCE_MARKER not in text:
        raise CliError(f"downloaded file from {source_url} is not the Klippee CLI")
    version_match = CLI_VERSION_ASSIGNMENT.search(text)
    if version_match is None:
        raise CliError(f"downloaded CLI from {source_url} does not declare a version")
    try:
        compile(text, source_url, "exec")
    except SyntaxError as error:
        raise CliError(f"downloaded CLI from {source_url} is invalid Python: {error.msg}") from error
    return text, version_match.group(1)


def download_cli_source(source_url: str) -> bytes:
    status, body = run_curl(
        source_url,
        max_bytes=MAX_CLI_BYTES,
        failure_message=f"could not download {source_url}",
    )
    if not 200 <= status < 300:
        raise CliError(f"could not download {source_url}: server returned HTTP {status}")
    return body


def refresh_moonraker_agent_after_upgrade() -> None:
    unit = moonraker_agent_unit_path()
    if not unit.is_file():
        print("klippee: Moonraker agent service is not installed; no agent restart needed")
        return
    try:
        unit_content = unit.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise CliError(f"Klippee CLI is installed, but the Moonraker agent unit could not be read: {error}") from error
    if path_is_link(unit) or MOONRAKER_AGENT_UNIT_MARKER not in unit_content:
        print(f"klippee: {unit.name} is not a Klippee-managed unit; it was not restarted")
        return
    try:
        systemctl = systemctl_command()
    except CliError as error:
        raise CliError(
            f"Klippee CLI is installed, but the managed Moonraker agent state could not be checked: {error}"
        ) from error
    try:
        state_result = subprocess.run(
            [*systemctl, "--user", "is-active", unit.name],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CliError(
            f"Klippee CLI is installed, but the managed Moonraker agent state check failed: {error}"
        ) from error
    state = state_result.stdout.strip().lower()
    if state_result.returncode != 0:
        if state_result.returncode in {3, 4} or state in {
            "activating",
            "deactivating",
            "failed",
            "inactive",
            "unknown",
        }:
            label = state or f"systemctl exit {state_result.returncode}"
            print(f"klippee: managed Moonraker agent is installed but not active ({label}); it was not restarted")
            print(f"klippee: start {unit.name} manually to activate the upgraded agent")
            return
        detail = state_result.stderr.strip() or state or f"systemctl exit {state_result.returncode}"
        raise CliError(
            f"Klippee CLI is installed, but the managed Moonraker agent state could not be determined: {detail}"
        )
    if state != "active":
        raise CliError(
            "Klippee CLI is installed, but systemctl returned an unexpected Moonraker agent state: "
            f"{state or 'empty'}"
        )
    try:
        restart_result = subprocess.run(
            [*systemctl, "--user", "try-restart", unit.name],
            capture_output=True,
            check=False,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CliError(
            f"Klippee CLI is installed, but the active Moonraker agent could not be restarted: {error}"
        ) from error
    if restart_result.returncode != 0:
        detail = restart_result.stderr.strip() or f"systemctl exit {restart_result.returncode}"
        raise CliError(
            f"Klippee CLI is installed, but the active Moonraker agent could not be restarted: {detail}"
        )
    print(f"klippee: restarted active {unit.name} to load the upgraded agent")


def cmd_upgrade(args: list[str]) -> int:
    if args:
        raise CliError("upgrade does not accept arguments")
    if not sys.argv[0] or sys.argv[0] == "-":
        raise CliError("cannot upgrade a CLI streamed on standard input; install it first")
    destination = Path(sys.argv[0]).expanduser().resolve()
    if not destination.is_file():
        raise CliError(f"installed CLI not found: {destination}")
    source_url = f"{upgrade_base_url()}/install/klippee.py"
    print(f"klippee: checking {source_url}")
    downloaded = download_cli_source(source_url)
    _source_text, downloaded_version = validate_cli_source(downloaded, source_url)
    if downloaded == destination.read_bytes():
        print(f"klippee: already up to date (version {CLI_VERSION})")
        refresh_moonraker_agent_after_upgrade()
        print("klippee: UPGRADE SUCCESSFUL")
        return 0
    if cli_version_key(downloaded_version) <= cli_version_key(CLI_VERSION):
        raise CliError(
            f"refusing CLI downgrade or same-version replacement: {CLI_VERSION} -> {downloaded_version}"
        )

    write_atomic_bytes(destination, downloaded, mode=destination.stat().st_mode & 0o777)
    print(f"klippee: upgraded CLI at {destination}")
    print(f"klippee: version {CLI_VERSION} -> {downloaded_version}")
    refresh_moonraker_agent_after_upgrade()
    print("klippee: UPGRADE SUCCESSFUL")
    return 0


def default_install_prefix() -> Path:
    override = os.environ.get("KLIPPEE_PREFIX")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        return Path(local_app_data).expanduser() / "Klippee" if local_app_data else home_dir() / "AppData" / "Local" / "Klippee"
    return home_dir() / ".local"


def write_windows_launcher(bindir: Path, script: Path) -> Path:
    launcher = bindir / "klippee.cmd"
    interpreter = str(Path(sys.executable).resolve()).replace("%", "%%")
    launcher.write_text(
        "@echo off\r\n"
        f'"{interpreter}" "%~dp0{script.name}" %*\r\n'
        "exit /b %errorlevel%\r\n",
        encoding="utf-8",
    )
    return launcher


def ensure_windows_user_path(bindir: Path) -> None:
    if os.name != "nt" or os.environ.get("KLIPPEE_PREFIX"):
        return
    try:
        import ctypes
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            try:
                current_path, value_type = winreg.QueryValueEx(key, "Path")
            except FileNotFoundError:
                current_path, value_type = "", winreg.REG_EXPAND_SZ
            normalized_target = os.path.normcase(os.path.normpath(str(bindir)))
            entries = [entry.strip().strip('"') for entry in str(current_path).split(";") if entry.strip()]
            if any(os.path.normcase(os.path.normpath(entry)) == normalized_target for entry in entries):
                os.environ["PATH"] = os.pathsep.join([str(bindir), os.environ.get("PATH", "")])
                return
            updated_path = f"{current_path.rstrip(';')};{bindir}" if current_path else str(bindir)
            winreg.SetValueEx(key, "Path", 0, value_type, updated_path)
        os.environ["PATH"] = os.pathsep.join([str(bindir), os.environ.get("PATH", "")])
        try:
            ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001A, 0, "Environment", 0x0002, 5000, None)
        except (AttributeError, OSError, TypeError):
            pass
        print(f"klippee: added {bindir} to your user PATH; open a new terminal before running klippee")
    except (ImportError, OSError) as error:
        eprint(f"klippee: warning: could not add {bindir} to your user PATH: {error}")


def cmd_install(_args: list[str]) -> int:
    print("klippee: starting installation")
    prefix = default_install_prefix()
    bindir = prefix / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    destination = bindir / ("klippee.py" if os.name == "nt" else "klippee")
    source_name = str(globals().get("__file__") or "")
    streamed_source = sys.argv[0] == "-" or (source_name.startswith("<") and source_name.endswith(">"))
    source = Path(source_name).resolve() if source_name else Path()
    if not streamed_source and source.is_file():
        source_url = str(source)
        downloaded = source.read_bytes()
    else:
        source_url = f"{install_base_url()}/install/klippee.py"
        downloaded = download_cli_source(source_url)
    validate_cli_source(downloaded, source_url)

    write_atomic_bytes(destination, downloaded, mode=0o700)
    launcher = write_windows_launcher(bindir, destination) if os.name == "nt" else destination
    print(f"klippee: installed CLI at {launcher}")
    ensure_windows_user_path(bindir)

    repository_id = os.environ.get("KLIPPEE_REPOSITORY_ID", "")
    token = os.environ.get("KLIPPEE_TOKEN", "")
    initial_sync_failed = False
    if repository_id and token:
        cmd_init([])
        capture_current = os.environ.get("KLIPPEE_CAPTURE_CURRENT", "0") == "1"
        apply_current = os.environ.get("KLIPPEE_APPLY_CURRENT", "0") == "1"
        if capture_current and apply_current:
            raise CliError("choose either KLIPPEE_CAPTURE_CURRENT or KLIPPEE_APPLY_CURRENT")
        if capture_current:
            print("klippee: capturing the current printer configuration")
            try:
                cmd_capture(["--note", "Initial import from printer"])
            except CliError as error:
                eprint_cli_error(error)
                eprint(
                    "klippee: initial import failed; fix the issue above, "
                    f"then run '{destination} capture' manually"
                )
                initial_sync_failed = True
        elif apply_current:
            print("klippee: applying the desired configuration")
            try:
                cmd_apply(["--yes"])
            except CliError as error:
                eprint_cli_error(error)
                eprint(
                    "klippee: initial apply failed; fix the issue above, "
                    f"then run '{launcher} apply' manually"
                )
                initial_sync_failed = True
    else:
        print("klippee: configuration not provided; CLI installation only")
        print("klippee: run klippee init <base-url> <repo-id> <token> <config-dir>")

    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if str(bindir) not in path_entries:
        print(f"klippee: note: {bindir} is not on your PATH; use the full path below or add that folder to PATH")
        if os.name != "nt":
            print(f"klippee:   echo 'export PATH=\"{bindir}:$PATH\"' >> ~/.profile")
    print(f"klippee: try '{launcher} target', '{launcher} check', or '{launcher} apply'")
    if initial_sync_failed:
        eprint("klippee: INSTALLATION FAILED")
        eprint("klippee: the CLI was installed, but the initial configuration sync did not complete")
        return 1
    print("klippee: INSTALLATION SUCCESSFUL")
    return 0


def usage() -> None:
    print(
        """Usage: klippee <command> [options]

Commands:
  init [--desktop|--printer] [base_url repo_id token config_dir]
  target
  check [--diff]
  apply [--yes|--if-clean]
  capture [--note "text"]
  recover [cloud:<id>|local:<name>]
  variables list|set|unset|doctor
  query-box-reset-reason
  upload-diagnostics [klippy.log path]
  upgrade
  install
  install-moonraker
  install-timer
  moonraker-agent (internal; started by the install-moonraker service)
  help, -h, --help
"""
    )


COMMANDS = {
    "init": cmd_init,
    "target": cmd_target,
    "check": cmd_check,
    "apply": cmd_apply,
    "capture": cmd_capture,
    "recover": cmd_recover,
    "variables": cmd_variables,
    "query-box-reset-reason": cmd_query_box_reset_reason,
    "upload-diagnostics": cmd_upload_diagnostics,
    "upgrade": cmd_upgrade,
    "install-moonraker": cmd_install_moonraker,
    "moonraker-agent": cmd_moonraker_agent,
    "install-timer": cmd_install_timer,
    "install": cmd_install,
}


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "help"
    if command in {"help", "-h", "--help"}:
        usage()
        return 0
    handler = COMMANDS.get(command)
    if handler is None:
        raise CliError(f"unknown command: {command}")
    arguments = argv[1:]
    for argument in arguments:
        if argument == "--":
            break
        if argument in {"-h", "--help"}:
            usage()
            return 0
    return handler(arguments)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (CliError, OSError) as error:
        eprint_cli_error(error)
        if sys.argv[1:2] == ["install"]:
            eprint("klippee: INSTALLATION FAILED")
        elif sys.argv[1:2] == ["upgrade"]:
            eprint("klippee: UPGRADE FAILED")
        raise SystemExit(1)
