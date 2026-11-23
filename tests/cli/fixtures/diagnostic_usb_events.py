"""Bounded persistent USB collection and ZIP integration; synthetic files only."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('klippee_client', sys.argv[1])
client = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = client
spec.loader.exec_module(client)

with tempfile.TemporaryDirectory() as name:
    root = Path(name)
    record = b'{"schema":1,"action":"remove","port":"2-1.3","ids":"1d50/614e/100","bootId":"11111111-2222-3333-4444-555555555555","epoch":1800000126,"monotonic":126}\n'
    (root / 'events.jsonl').write_bytes(record)
    (root / 'events.jsonl.1').write_bytes(record)
    (root / 'unrelated-secret.log').write_text('do not collect')
    artifacts, warnings = client.collect_persistent_usb_diagnostics(root)
    assert not warnings
    assert [item[0] for item in artifacts] == ['logs/usb-events.previous.log', 'logs/usb-events.log']
    assert all(item[1] == record and item[2] == 'usb-events' for item in artifacts)
    log = root / 'klippy.log'
    log.write_text('Stats 1.0: sysload=0.2\n')
    config = SimpleNamespace(client_mode='printer', repository_id='fixture')
    with patch.object(client, 'collect_persistent_usb_diagnostics', return_value=(artifacts, [])), \
            patch.object(client, 'collect_moonraker_diagnostics', return_value=([], [])), \
            patch.object(client, 'collect_journal_diagnostics', return_value=([], [])), \
            patch.object(client, 'collect_host_info', return_value={}), \
            patch.object(client, 'collect_host_scheduling_info', return_value={}), \
            patch.object(client, 'collect_usb_serial_topology', return_value=[]):
        bundle, *_ = client.prepare_diagnostic_bundle(config, log)
        try:
            with zipfile.ZipFile(bundle) as archive:
                assert archive.read('logs/usb-events.log') == record
                assert archive.read('logs/usb-events.previous.log') == record
                assert not any('secret' in path for path in archive.namelist())
                manifest = json.loads(archive.read('manifest.json'))
                assert len([item for item in manifest['artifacts'] if item['kind'] == 'usb-events']) == 2
        finally:
            bundle.unlink()
    # Keep only complete records from the newest bounded tail.
    (root / 'events.jsonl').write_bytes(record * 3000)
    bounded, _ = client.collect_persistent_usb_diagnostics(root)
    current = next(item for item in bounded if item[0] == 'logs/usb-events.log')
    assert current[3] and len(current[1]) <= 256 * 1024
    assert all(json.loads(line)['schema'] == 1 for line in current[1].splitlines())
    assert client.collect_persistent_usb_diagnostics(root / 'absent') == ([], [])
    # Windows symlinks need an elevated developer environment; exercise where available.
    (root / 'events.jsonl').unlink()
    try:
        (root / 'events.jsonl').symlink_to(root / 'unrelated-secret.log')
    except OSError:
        pass
    else:
        safe, warnings = client.collect_persistent_usb_diagnostics(root)
        assert len(safe) == 1 and warnings
        assert b'do not collect' not in b''.join(item[1] for item in safe)
