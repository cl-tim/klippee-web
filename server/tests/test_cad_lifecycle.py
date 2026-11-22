from __future__ import annotations

import asyncio
import os
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import httpx

from server.cad_app import admitted_cad_body, app, run_process


def available_cad_slot() -> asyncio.Queue[object]:
    slot: asyncio.Queue[object] = asyncio.Queue(maxsize=1)
    slot.put_nowait(object())
    return slot


async def wait_for_path(path: Path, timeout: float = 2) -> None:
    async with asyncio.timeout(timeout):
        while not path.exists():
            await asyncio.sleep(0.01)


def read_pid(path: Path) -> int:
    return int(path.read_text(encoding="utf-8"))


def process_is_running(pid: int) -> bool:
    if os.name == "nt":
        # os.kill(pid, 0) terminates rather than probes on Windows. Query the
        # process handle directly so the assertion cannot alter the result.
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

    if sys.platform.startswith("linux"):
        try:
            state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
        except (FileNotFoundError, IndexError, OSError):
            return False
        if state == "Z":
            return False
    return True


async def wait_for_process_exit(pid: int, timeout: float = 2) -> None:
    async with asyncio.timeout(timeout):
        while process_is_running(pid):
            await asyncio.sleep(0.01)


async def stop_test_processes(*pids: int, group_id: int | None = None) -> None:
    if os.name == "posix" and group_id:
        try:
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for pid in pids:
        if not pid or not process_is_running(pid):
            continue
        try:
            os.kill(pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
        except ProcessLookupError:
            pass
    for pid in pids:
        if not pid:
            continue
        try:
            await wait_for_process_exit(pid, timeout=1)
        except TimeoutError:
            pass


def write_process_tree_scripts(root: Path) -> tuple[Path, Path]:
    child_script = root / "child.py"
    parent_script = root / "parent.py"
    child_script.write_text(
        "from pathlib import Path\n"
        "import os, sys, time\n"
        "Path(sys.argv[1]).write_text(str(os.getpid()))\n"
        "Path(sys.argv[2]).write_text('ready')\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    parent_script.write_text(
        "from pathlib import Path\n"
        "import os, subprocess, sys, time\n"
        "parent_pid = Path(sys.argv[2])\n"
        "ready = Path(sys.argv[4])\n"
        "parent_pid.write_text(str(os.getpid()))\n"
        "subprocess.Popen(\n"
        "    [sys.executable, sys.argv[1], sys.argv[3], sys.argv[4]],\n"
        "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n"
        ")\n"
        "deadline = time.monotonic() + 5\n"
        "while not ready.exists() and time.monotonic() < deadline:\n"
        "    time.sleep(0.01)\n"
        "if not ready.exists():\n"
        "    raise SystemExit(3)\n"
        "if sys.argv[5] == 'wait':\n"
        "    time.sleep(60)\n",
        encoding="utf-8",
    )
    return parent_script, child_script


class CadAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.slot = available_cad_slot()
        self.slot_patch = patch("server.cad_app.cad_slot", self.slot)
        self.slot_patch.start()

    async def asyncTearDown(self) -> None:
        self.slot_patch.stop()

    async def test_drip_feed_hits_total_deadline_and_releases_slot(self) -> None:
        stream_cancelled = asyncio.Event()

        class DripRequest:
            headers: dict[str, str] = {}

            async def stream(self):
                try:
                    while True:
                        await asyncio.sleep(0)
                        yield b"x"
                finally:
                    stream_cancelled.set()

        dependency = admitted_cad_body(DripRequest())  # type: ignore[arg-type]
        with patch("server.cad_app.CAD_BODY_TIMEOUT_SECONDS", 0.02):
            with self.assertRaises(HTTPException) as raised:
                await asyncio.wait_for(anext(dependency), timeout=1)

        self.assertEqual(raised.exception.status_code, 408)
        self.assertTrue(stream_cancelled.is_set())
        self.assertEqual(self.slot.qsize(), 1)

    async def test_asgi_cancellation_releases_render_admission(self) -> None:
        render_started = asyncio.Event()
        render_cancelled = asyncio.Event()
        rejected_body_reads = 0
        payload = {
            "files": [{"name": "main.scad", "source": "cube(1);"}],
            "mainFile": "main.scad",
            "parameters": {},
        }

        async def blocking_run_process(*_args, **_kwargs):
            render_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                render_cancelled.set()

        async def rejected_body():
            nonlocal rejected_body_reads
            rejected_body_reads += 1
            yield b'{"files":[]}'

        transport = httpx.ASGITransport(app=app)
        first_task: asyncio.Task[httpx.Response] | None = None
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            try:
                with patch("server.cad_app.run_process", blocking_run_process):
                    first_task = asyncio.create_task(client.post("/api/render", json=payload))
                    await asyncio.wait_for(render_started.wait(), timeout=1)
                    self.assertEqual(self.slot.qsize(), 0)

                    rejected = await client.post(
                        "/api/render",
                        content=rejected_body(),
                        headers={"content-type": "application/json"},
                    )
                    self.assertEqual(rejected.status_code, 429)
                    self.assertEqual(rejected_body_reads, 0)

                    first_task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(first_task, timeout=2)
                    self.assertTrue(render_cancelled.is_set())
                    self.assertEqual(self.slot.qsize(), 1)
            finally:
                if first_task is not None and not first_task.done():
                    first_task.cancel()
                    await asyncio.gather(first_task, return_exceptions=True)


class CadProcessLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancellation_stops_the_renderer_and_propagates(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            pid_file = root / "renderer.pid"
            ready = root / "ready"
            script = (
                "from pathlib import Path; import os, sys, time; "
                "Path(sys.argv[1]).write_text(str(os.getpid())); "
                "Path(sys.argv[2]).write_text('ready'); time.sleep(60)"
            )
            task: asyncio.Task[tuple[bytes, bytes]] | None = None
            pid = 0
            try:
                task = asyncio.create_task(
                    run_process(
                        sys.executable,
                        "-c",
                        script,
                        str(pid_file),
                        str(ready),
                        cwd=root,
                        timeout=5,
                    )
                )
                await wait_for_path(ready)
                pid = read_pid(pid_file)
                self.assertTrue(process_is_running(pid))
                task.cancel()

                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, timeout=2)
                await wait_for_process_exit(pid)
                self.assertFalse(process_is_running(pid))
            finally:
                if task is not None and not task.done():
                    task.cancel()
                await stop_test_processes(pid)
                if task is not None and not task.done():
                    try:
                        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=1)
                    except TimeoutError:
                        pass

    async def test_timeout_returns_504_and_stops_the_renderer(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            pid_file = root / "renderer.pid"
            ready = root / "ready"
            script = (
                "from pathlib import Path; import os, sys, time; "
                "Path(sys.argv[1]).write_text(str(os.getpid())); "
                "Path(sys.argv[2]).write_text('ready'); time.sleep(60)"
            )
            pid = 0
            try:
                with self.assertRaises(HTTPException) as raised:
                    await asyncio.wait_for(
                        run_process(
                            sys.executable,
                            "-c",
                            script,
                            str(pid_file),
                            str(ready),
                            cwd=root,
                            timeout=1,
                        ),
                        timeout=3,
                    )

                self.assertEqual(raised.exception.status_code, 504)
                self.assertTrue(ready.exists())
                pid = read_pid(pid_file)
                await wait_for_process_exit(pid)
                self.assertFalse(process_is_running(pid))
            finally:
                await stop_test_processes(pid)

    @unittest.skipUnless(os.name == "posix", "POSIX process groups are enforced in production")
    async def test_parent_exit_still_reaps_its_process_group(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent_script, child_script = write_process_tree_scripts(root)
            parent_pid_file = root / "parent.pid"
            child_pid_file = root / "child.pid"
            ready = root / "child-ready"
            parent_pid = 0
            child_pid = 0
            try:
                await run_process(
                    sys.executable,
                    str(parent_script),
                    str(child_script),
                    str(parent_pid_file),
                    str(child_pid_file),
                    str(ready),
                    "exit",
                    cwd=root,
                    timeout=6,
                )
                self.assertTrue(ready.exists())
                parent_pid = read_pid(parent_pid_file)
                child_pid = read_pid(child_pid_file)
                await wait_for_process_exit(child_pid)
                self.assertFalse(process_is_running(child_pid))
            finally:
                await stop_test_processes(parent_pid, child_pid, group_id=parent_pid or None)

    @unittest.skipUnless(os.name == "posix", "POSIX process groups are enforced in production")
    async def test_cancellation_reaps_parent_and_descendant_process_group(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent_script, child_script = write_process_tree_scripts(root)
            parent_pid_file = root / "parent.pid"
            child_pid_file = root / "child.pid"
            ready = root / "child-ready"
            parent_pid = 0
            child_pid = 0
            task: asyncio.Task[tuple[bytes, bytes]] | None = None
            try:
                task = asyncio.create_task(
                    run_process(
                        sys.executable,
                        str(parent_script),
                        str(child_script),
                        str(parent_pid_file),
                        str(child_pid_file),
                        str(ready),
                        "wait",
                        cwd=root,
                        timeout=10,
                    )
                )
                await wait_for_path(ready)
                parent_pid = read_pid(parent_pid_file)
                child_pid = read_pid(child_pid_file)
                self.assertTrue(process_is_running(parent_pid))
                self.assertTrue(process_is_running(child_pid))

                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, timeout=2)
                await wait_for_process_exit(parent_pid)
                await wait_for_process_exit(child_pid)
                self.assertFalse(process_is_running(parent_pid))
                self.assertFalse(process_is_running(child_pid))
            finally:
                if task is not None and not task.done():
                    task.cancel()
                await stop_test_processes(parent_pid, child_pid, group_id=parent_pid or None)
                if task is not None and not task.done():
                    try:
                        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=1)
                    except TimeoutError:
                        pass


if __name__ == "__main__":
    unittest.main()
