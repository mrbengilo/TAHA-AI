"""Pause TAHA cron without killing an in-flight request while catalog conflicts are reviewed."""
import fcntl
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

WORKSPACE = '00000000-0000-4000-8000-000000000001'
IMAGE = 'tahashoes-taha-ai:010c0193ab4ed57991a60e17aee2925a729ac117'
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=30)


def validate_marker():
    data = json.loads(MARKER.read_text())
    products = data.get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_HOLD_MARKER_CHANGED')
    ids = [row.get('runId') for row in products if isinstance(row, dict)]
    if len(set(ids)) != 15 or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
        raise RuntimeError('CATALOG_HOLD_MARKER_CHANGED')
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_runs'").fetchone():
                continue
            placeholders = ','.join('?' for _ in ids)
            count = db.execute(
                f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})",
                [WORKSPACE, *ids],
            ).fetchone()[0]
            if count != 15:
                raise RuntimeError('CATALOG_HOLD_RUN_SET_CHANGED')
            return
    raise RuntimeError('CATALOG_HOLD_DATABASE_MISSING')


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.State.Status}}').stdout.strip()
        if runtime != IMAGE + '|running':
            raise RuntimeError('CATALOG_HOLD_DEPLOYMENT_CHANGED')
        validate_marker()
        command('systemctl', 'stop', 'taha-ai-cron.timer')
        for _ in range(180):
            state = command('systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value').stdout.strip()
            if state not in ('active', 'activating', 'deactivating'):
                break
            time.sleep(1)
        else:
            raise RuntimeError('CATALOG_HOLD_DRAIN_TIMEOUT')
        timer = command('systemctl', 'is-active', 'taha-ai-cron.timer', check=False).stdout.strip()
        if timer == 'active':
            raise RuntimeError('CATALOG_HOLD_TIMER_STILL_ACTIVE')
        print('CATALOG_CRON_HELD=yes', flush=True)
        print('CATALOG_CRON_SERVICE_DRAINED=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_HOLD_FAILED', file=sys.stderr)
        sys.exit(1)
