from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import json
import logging
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from typing import Annotated, Any
import uuid

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from server.scad_to_build123d import ScadConversionError, convert_csg

logger = logging.getLogger("klippee.cad")

MAX_CAD_BODY_BYTES = int(os.getenv("KLIPPEE_MAX_CAD_BODY_BYTES", str(64 * 1024 * 1024)))
MAX_SCAD_FILES = 64
MAX_SCAD_SOURCE_BYTES = 32 * 1024 * 1024
CAD_BODY_TIMEOUT_SECONDS = float(os.getenv("KLIPPEE_CAD_BODY_TIMEOUT_SECONDS", "30"))
CAD_TIMEOUT_SECONDS = float(os.getenv("KLIPPEE_CAD_TIMEOUT_SECONDS", "120"))
MAX_CAD_PROCESS_OUTPUT_BYTES = int(os.getenv("KLIPPEE_MAX_CAD_PROCESS_OUTPUT_BYTES", str(1024 * 1024)))
MAX_CAD_ARTIFACT_BYTES = int(os.getenv("KLIPPEE_MAX_CAD_ARTIFACT_BYTES", str(64 * 1024 * 1024)))
OPENSCAD_BIN = os.getenv("OPENSCAD_BIN", "openscad")
BOSL2_VERSION = os.getenv("BOSL2_VERSION", "not-installed")
PARAMETER_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SCAD_PATH_PART = re.compile(r'^[^<>:"|?*\x00-\x1f\x7f]+$')
SCAD_INCLUDE = re.compile(r"\b(?:include|use)\s*<([^>\r\n]+)>", re.IGNORECASE)
BUNDLED_SCAD_LIBRARY_ROOTS = frozenset({"BOSL2"})
SCAD_EXTERNAL_IMPORT = re.compile(
    r"\b(?:import|surface|import_dxf|import_stl|import_off|dxf_dim|dxf_cross)\s*\(",
    re.IGNORECASE,
)
cad_slot: asyncio.Queue[object] = asyncio.Queue(maxsize=1)
cad_slot.put_nowait(object())

app = FastAPI(title="Klippee transient CAD API", version="0.1.0")


class CadResourceLimitError(RuntimeError):
    pass


@app.middleware("http")
async def security_headers(request: Request, call_next):
    request_id = request.headers.get("cf-ray") or uuid.uuid4().hex
    try:
        response = await call_next(request)
    except Exception as exc:
        logger.exception("Unhandled CAD request failure", extra={"request_id": request_id})
        response = JSONResponse(
            status_code=500,
            content={"detail": f"CAD processing failed: {type(exc).__name__}", "requestId": request_id},
        )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Request-ID"] = request_id
    return response


@app.get("/")
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "runtime": "cad-python",
        "storage": "none",
        "engines": {
            "build123dRender": "build123d",
            "cadImport": "OpenCascade",
            "scadRender": "OpenSCAD CLI",
        },
        "scadLibraries": {
            "BOSL2": BOSL2_VERSION,
        },
    }


async def read_limited_body(request: Request) -> bytearray:
    try:
        content_length = int(request.headers.get("content-length") or "0")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc
    if content_length < 0:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.")
    if content_length > MAX_CAD_BODY_BYTES:
        raise HTTPException(status_code=413, detail="CAD payload is too large.")
    body = bytearray()
    try:
        async with asyncio.timeout(CAD_BODY_TIMEOUT_SECONDS):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_CAD_BODY_BYTES:
                    raise HTTPException(status_code=413, detail="CAD payload is too large.")
                body.extend(chunk)
    except TimeoutError as exc:
        raise HTTPException(status_code=408, detail="CAD request body exceeded the time limit.") from exc
    if not body:
        raise HTTPException(status_code=400, detail="The request body is empty.")
    return body


async def admitted_cad_body(request: Request) -> AsyncIterator[bytearray]:
    try:
        token = cad_slot.get_nowait()
    except asyncio.QueueEmpty as exc:
        raise HTTPException(status_code=429, detail="The CAD service is busy. Try again shortly.") from exc

    try:
        yield await read_limited_body(request)
    finally:
        cad_slot.put_nowait(token)


CadRequestBody = Annotated[bytearray, Depends(admitted_cad_body, scope="function")]


async def _read_limited_process_stream(
    stream: asyncio.StreamReader | None,
    maximum: int,
) -> bytes:
    if stream is None:
        return b""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(64 * 1024)
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > maximum:
            raise CadResourceLimitError("CAD engine diagnostic output exceeded the service limit.")
        chunks.append(chunk)


def _check_artifact_limits(artifact_limits: tuple[tuple[Path, int], ...]) -> None:
    for path, maximum in artifact_limits:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            continue
        if size > maximum:
            raise CadResourceLimitError("CAD engine generated an artifact larger than the service limit.")


async def _monitor_artifact_limits(
    process: asyncio.subprocess.Process,
    artifact_limits: tuple[tuple[Path, int], ...],
) -> None:
    while process.returncode is None:
        _check_artifact_limits(artifact_limits)
        await asyncio.sleep(0.01)
    _check_artifact_limits(artifact_limits)


def read_cad_artifact(
    path: Path,
    *,
    minimum: int = 0,
    maximum: int = MAX_CAD_ARTIFACT_BYTES,
    empty_detail: str = "The CAD engine returned an empty artifact.",
) -> bytes:
    if not path.exists() or path.stat().st_size < minimum:
        raise HTTPException(status_code=422, detail=empty_detail)
    if path.stat().st_size > maximum:
        raise HTTPException(status_code=413, detail="The generated CAD artifact is too large.")
    return path.read_bytes()


def _kill_process_tree_now(process: asyncio.subprocess.Process) -> None:
    tree_killed = False
    if os.name == "posix":
        try:
            # POSIX renderers start a new session, so the leader PID is also
            # the process-group ID. Attempt this even after the leader exits:
            # a descendant may still own inherited pipes or keep computing.
            os.killpg(process.pid, signal.SIGKILL)
            tree_killed = True
        except ProcessLookupError:
            pass
        except OSError:
            logger.exception("Could not terminate the CAD process group", extra={"pid": process.pid})
    elif os.name == "nt" and process.returncode is None:
        try:
            completed = subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
                stderr=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                timeout=5,
            )
            tree_killed = completed.returncode == 0
        except (OSError, subprocess.SubprocessError):
            logger.exception("Could not terminate the Windows CAD process tree", extra={"pid": process.pid})

    if not tree_killed and process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def _finalize_process(
    process: asyncio.subprocess.Process,
    tasks: tuple[asyncio.Task[Any], ...],
) -> None:
    # Signal synchronously before the first await so external cancellation
    # cannot release admission while a renderer is still consuming resources.
    _kill_process_tree_now(process)
    for task in tasks:
        if not task.done():
            task.cancel()
    try:
        await process.wait()
    except (ChildProcessError, ProcessLookupError):
        pass
    except Exception:
        logger.exception("Could not reap the CAD process", extra={"pid": process.pid})
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:
        logger.exception("Could not finalize CAD process monitors", extra={"pid": process.pid})


async def run_process(
    *args: str,
    cwd: Path,
    timeout: float = CAD_TIMEOUT_SECONDS,
    artifact_limits: tuple[tuple[Path, int], ...] = (),
    output_limit: int = MAX_CAD_PROCESS_OUTPUT_BYTES,
) -> tuple[bytes, bytes]:
    if shutil.which(args[0]) is None:
        raise HTTPException(status_code=503, detail="The CAD engine is not installed.")
    process_options: dict[str, Any] = {}
    if os.name == "posix":
        process_options["start_new_session"] = True
    elif os.name == "nt":
        process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd),
            env={**os.environ, "QT_QPA_PLATFORM": "offscreen"},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **process_options,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="The CAD engine is not installed.") from exc

    wait_task = asyncio.create_task(process.wait())
    stdout_task = asyncio.create_task(_read_limited_process_stream(process.stdout, output_limit))
    stderr_task = asyncio.create_task(_read_limited_process_stream(process.stderr, output_limit))
    artifact_task = asyncio.create_task(_monitor_artifact_limits(process, artifact_limits))
    tasks = (wait_task, stdout_task, stderr_task, artifact_task)
    try:
        try:
            async with asyncio.timeout(timeout):
                returncode, stdout, stderr, _artifact_result = await asyncio.gather(*tasks)
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail="CAD processing exceeded the time limit.") from exc
        except CadResourceLimitError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc

        if returncode != 0:
            detail = _stderr_detail(stderr)
            raise HTTPException(status_code=422, detail=detail or f"CAD engine exited with code {returncode}.")
        return stdout, stderr
    finally:
        await _finalize_process(process, tasks)


def safe_scad_path(name: object) -> PurePosixPath:
    if not isinstance(name, str) or not name.strip() or len(name) > 240:
        raise HTTPException(status_code=400, detail="Each OpenSCAD file needs a valid name.")
    path = PurePosixPath(name.replace("\\", "/"))
    if (
        path.is_absolute()
        or ".." in path.parts
        or path.suffix.lower() != ".scad"
        or any(not SCAD_PATH_PART.fullmatch(part) for part in path.parts)
    ):
        raise HTTPException(status_code=400, detail="OpenSCAD files must use safe relative .scad paths.")
    return path


def scad_code_for_validation(source: str) -> str:
    """Mask comments and strings before scanning executable OpenSCAD code."""
    masked = list(source)
    index = 0
    state = "code"

    while index < len(source):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""

        if state == "code":
            if char == "/" and following == "/":
                masked[index] = masked[index + 1] = " "
                index += 2
                state = "line_comment"
                continue
            if char == "/" and following == "*":
                masked[index] = masked[index + 1] = " "
                index += 2
                state = "block_comment"
                continue
            if char == '"':
                masked[index] = " "
                index += 1
                state = "string"
                continue
        elif state == "line_comment":
            if char in "\r\n":
                state = "code"
            else:
                masked[index] = " "
        elif state == "block_comment":
            if char == "*" and following == "/":
                masked[index] = masked[index + 1] = " "
                index += 2
                state = "code"
                continue
            if char not in "\r\n":
                masked[index] = " "
        elif state == "string":
            masked[index] = " "
            if char == "\\" and following:
                masked[index + 1] = " "
                index += 2
                continue
            if char == '"':
                state = "code"

        index += 1

    return "".join(masked)


def validate_scad_source(source: str, available_files: set[PurePosixPath]) -> None:
    executable_source = scad_code_for_validation(source)
    if SCAD_EXTERNAL_IMPORT.search(executable_source):
        raise HTTPException(
            status_code=400,
            detail="External CAD and data imports are not supported by transient OpenSCAD rendering.",
        )
    for match in SCAD_INCLUDE.finditer(executable_source):
        include_path = safe_scad_path(match.group(1).strip())
        is_bundled_library = len(include_path.parts) > 1 and include_path.parts[0] in BUNDLED_SCAD_LIBRARY_ROOTS
        if include_path not in available_files and not is_bundled_library:
            raise HTTPException(status_code=400, detail=f"OpenSCAD include is missing: {include_path}")


def stage_scad_files(files: object, main_name: object, workspace: Path) -> PurePosixPath:
    """Validate an OpenSCAD file set and write it into a temporary workspace."""
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_SCAD_FILES:
        raise HTTPException(status_code=400, detail=f"Provide between 1 and {MAX_SCAD_FILES} OpenSCAD files.")
    normalized_files: dict[PurePosixPath, str] = {}
    source_bytes = 0
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("source"), str):
            raise HTTPException(status_code=400, detail="Each OpenSCAD file needs text source.")
        path = safe_scad_path(item.get("name"))
        if path in normalized_files:
            raise HTTPException(status_code=400, detail=f"Duplicate OpenSCAD file: {path}")
        source_bytes += len(item["source"].encode("utf-8"))
        if source_bytes > MAX_SCAD_SOURCE_BYTES:
            raise HTTPException(status_code=413, detail="OpenSCAD source is too large.")
        normalized_files[path] = item["source"]

    main_file = safe_scad_path(main_name)
    if main_file not in normalized_files:
        raise HTTPException(status_code=400, detail="Choose a valid entry OpenSCAD file.")
    for source in normalized_files.values():
        validate_scad_source(source, set(normalized_files))
    for path, source in normalized_files.items():
        target = workspace.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source, encoding="utf-8")
    return main_file


def _stderr_detail(stderr: bytes) -> str:
    """Trim renderer stderr to a bounded, human-readable diagnostic tail."""
    return stderr.decode("utf-8", errors="replace").strip()[-4_000:]


def parameter_definition(key: object, value: object) -> str:
    if not isinstance(key, str) or not PARAMETER_NAME.fullmatch(key):
        raise HTTPException(status_code=400, detail="Invalid OpenSCAD parameter name.")

    def render_parameter_value(item: object, depth: int = 0) -> str:
        if isinstance(item, str):
            if len(item) > 2_000:
                raise HTTPException(status_code=400, detail=f"OpenSCAD parameter {key} is too long.")
            return json.dumps(item, ensure_ascii=True)
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item):
            return str(item)
        if isinstance(item, list):
            if depth >= 4 or len(item) > 64:
                raise HTTPException(status_code=400, detail=f"OpenSCAD parameter {key} has an unsupported vector.")
            return f"[{','.join(render_parameter_value(child, depth + 1) for child in item)}]"
        raise HTTPException(status_code=400, detail=f"OpenSCAD parameter {key} has an unsupported value.")

    return f"{key}={render_parameter_value(value)}"


def _openscad_command(
    workspace: Path,
    main_file: PurePosixPath,
    parameters: dict[Any, Any],
    output_path: Path,
    extra_defines: tuple[str, ...] = (),
) -> list[str]:
    command = [
        OPENSCAD_BIN,
        "--enable",
        "textmetrics",
        "-o",
        str(output_path),
        str(workspace.joinpath(*main_file.parts)),
    ]
    for key, value in parameters.items():
        command.extend(("-D", parameter_definition(key, value)))
    for definition in extra_defines:
        command.extend(("-D", definition))
    return command


@app.post("/api/convert")
async def convert_cad(
    body: CadRequestBody,
    format: str = Query(pattern="^(step|iges|brep)$"),
    filename: str = Query(min_length=1, max_length=240),
    target: str = Query("scad", pattern="^(build123d|scad)$"),
) -> Response:
    started_at = time.monotonic()
    with TemporaryDirectory(prefix="klippee-cad-") as temporary:
        workspace = Path(temporary)
        source_name = Path(filename).name
        input_path = workspace / f"input.{format}"
        output_path = workspace / "converted.json"
        input_path.write_bytes(body)
        await run_process(
            sys.executable,
            "-m",
            "server.cad_geometry",
            "--format",
            format,
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--source-name",
            source_name,
            "--target",
            target,
            cwd=Path(__file__).resolve().parent.parent,
            artifact_limits=((output_path, MAX_CAD_ARTIFACT_BYTES),),
        )
        result = json.loads(read_cad_artifact(output_path).decode("utf-8"))

    result["duration"] = (time.monotonic() - started_at) * 1_000
    return JSONResponse(result)


@app.post("/api/render-build123d")
async def render_build123d(body: CadRequestBody, mode: str = Query("preview", pattern="^(preview|export)$")) -> Response:
    """Render a validated reconstruction plan in a constrained build123d subprocess."""
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Expected a build123d render request.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Expected a build123d render request.")

    started_at = time.monotonic()
    with TemporaryDirectory(prefix="klippee-build123d-") as temporary:
        workspace = Path(temporary)
        input_path = workspace / "request.json"
        output_path = workspace / "render.stl"
        input_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
        await run_process(
            sys.executable,
            "-m",
            "server.build123d_runner",
            "--input",
            str(input_path),
            "--mode",
            mode,
            "--output",
            str(output_path),
            cwd=Path(__file__).resolve().parent.parent,
            artifact_limits=((output_path, MAX_CAD_ARTIFACT_BYTES),),
        )
        output = read_cad_artifact(
            output_path,
            minimum=84,
            empty_detail="build123d returned an empty STL.",
        )

    duration_ms = (time.monotonic() - started_at) * 1_000
    return Response(
        output,
        media_type="model/stl",
        headers={
            "Content-Disposition": 'attachment; filename="build123d-model.stl"',
            "X-CAD-Duration-Ms": f"{duration_ms:.1f}",
        },
    )


@app.post("/api/convert-scad")
async def convert_scad(body: CadRequestBody) -> Response:
    """Translate OpenSCAD source into build123d Python source.

    OpenSCAD flattens the script to a CSG tree first, so every module, loop and
    variable is already resolved before translation begins.
    """
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Expected an OpenSCAD conversion request.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Expected an OpenSCAD conversion request.")
    parameters = payload.get("parameters", {})
    if not isinstance(parameters, dict):
        raise HTTPException(status_code=400, detail="OpenSCAD parameters must be an object.")

    started_at = time.monotonic()
    with TemporaryDirectory(prefix="klippee-convert-") as temporary:
        workspace = Path(temporary)
        main_file = stage_scad_files(payload.get("files"), payload.get("mainFile"), workspace)
        flattened_path = workspace / "flattened.csg"
        command = _openscad_command(workspace, main_file, parameters, flattened_path)
        _stdout, stderr = await run_process(
            *command,
            cwd=workspace,
            artifact_limits=((flattened_path, MAX_CAD_ARTIFACT_BYTES),),
        )
        if not flattened_path.exists():
            detail = _stderr_detail(stderr)
            raise HTTPException(status_code=422, detail=detail or "OpenSCAD produced no CSG output.")
        flattened = read_cad_artifact(flattened_path).decode("utf-8")

        try:
            result = convert_csg(flattened)
        except ScadConversionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse({
        "coverage": round(result.coverage, 4),
        "convertedNodes": result.converted_nodes,
        "duration": (time.monotonic() - started_at) * 1_000,
        "filename": f"{re.sub(r'[^A-Za-z0-9_]+', '_', main_file.stem).strip('_') or 'model'}.py",
        "nodeCount": result.node_count,
        "source": result.source,
        "unsupported": sorted(set(result.unsupported)),
    })



@app.post("/api/render")
async def render_scad(body: CadRequestBody, mode: str = Query("preview", pattern="^(preview|export)$")) -> Response:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Expected an OpenSCAD render request.") from exc

    files = payload.get("files") if isinstance(payload, dict) else None
    parameters = payload.get("parameters", {}) if isinstance(payload, dict) else None
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_SCAD_FILES:
        raise HTTPException(status_code=400, detail=f"Provide between 1 and {MAX_SCAD_FILES} OpenSCAD files.")
    if not isinstance(parameters, dict):
        raise HTTPException(status_code=400, detail="OpenSCAD parameters must be an object.")

    started_at = time.monotonic()
    with TemporaryDirectory(prefix="klippee-scad-") as temporary:
        workspace = Path(temporary)
        main_file = stage_scad_files(files, payload.get("mainFile"), workspace)

        output_path = workspace / "render.stl"
        command = _openscad_command(
            workspace,
            main_file,
            parameters,
            output_path,
            extra_defines=(f"$fn={24 if mode == 'preview' else 48}",),
        )
        _stdout, stderr = await run_process(
            *command,
            cwd=workspace,
            artifact_limits=((output_path, MAX_CAD_ARTIFACT_BYTES),),
        )
        try:
            output = read_cad_artifact(
                output_path,
                minimum=84,
                empty_detail="OpenSCAD returned an empty STL.",
            )
        except HTTPException as error:
            if error.status_code != 422:
                raise
            detail = _stderr_detail(stderr)
            raise HTTPException(status_code=422, detail=detail or str(error.detail)) from error

    duration_ms = (time.monotonic() - started_at) * 1_000
    download_stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", main_file.stem).strip(" .") or "model"
    return Response(
        output,
        media_type="model/stl",
        headers={
            "Content-Disposition": f'attachment; filename="{download_stem}.stl"',
            "X-CAD-Duration-Ms": f"{duration_ms:.1f}",
        },
    )
