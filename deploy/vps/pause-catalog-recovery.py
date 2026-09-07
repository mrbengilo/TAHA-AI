"""Pause the non-isolated catalog recovery before any normal daily planning can run."""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import time

WORKSPACE = '00000000-0000-4000-8000-000000000001'
IMAGE = 'tahashoes-taha-ai:010c0193ab4ed57991a60e17aee2925a729ac117'
IMAGE_ID = 'sha256:3c4035316ec16398880dbceab5bc422c0824279f7816ef01625f91dba1f7b434'
LOCK = Path('/var/lock/taha-ai-release.lock')
CATALOG = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
PAUSED = Path('/var/lib/taha-ai/ops-recovery/catalog-recovery-v3-paused.json')


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=30)


def catalog_ids():
    products = json.loads(CATALOG.read_text()).get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_PAUSE_MARKER_CHANGED')
    ids = [row.get('runId') for row in products if isinstance(row, dict)]
    if len(ids) != 15 or len(set(ids)) != 15 \
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
        raise RuntimeError('CATALOG_PAUSE_MARKER_CHANGED')
    return ids


def find_database(ids):
    placeholders = ','.join('?' for _ in ids)
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'automation_runs', 'products', 'content_drafts', 'schedules', 'publish_jobs'}.issubset(tables):
                continue
            count = db.execute(
                f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})",
                [WORKSPACE, *ids],
            ).fetchone()[0]
            if count == 15:
                return path
    raise RuntimeError('CATALOG_PAUSE_DATABASE_MISSING')


def validate_isolated_state(database, ids):
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        completed = db.execute(
            f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders}) AND status='completed'",
            [WORKSPACE, *ids],
        ).fetchone()[0]
        competitors = db.execute(
            f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id NOT IN ({placeholders}) "
            f"AND product_id IN (SELECT product_id FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})) "
            f"AND status IN ('queued','processing')",
            [WORKSPACE, *ids, WORKSPACE, *ids],
        ).fetchone()[0]
        drafts = db.execute(
            f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND "
            f"json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders})",
            [WORKSPACE, *ids],
        ).fetchone()[0]
        schedules = db.execute(
            f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
            [WORKSPACE, *creators],
        ).fetchone()[0]
        jobs = db.execute(
            f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id "
            f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})",
            [WORKSPACE, *creators],
        ).fetchone()[0]
    if completed or competitors or drafts or schedules or jobs:
        raise RuntimeError('CATALOG_PAUSE_ISOLATION_LOST')


def replace_marker(value):
    PAUSED.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = PAUSED.with_name(PAUSED.name + '.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, separators=(',', ':'))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, PAUSED)
    directory = os.open(PAUSED.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    command('systemctl', 'stop', 'taha-ai-cron.timer')
    for _ in range(360):
        state = command('systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value').stdout.strip()
        if state not in ('active', 'activating', 'deactivating'):
            break
        time.sleep(1)
    else:
        raise RuntimeError('CATALOG_PAUSE_CRON_DRAIN_TIMEOUT')
    holders = command('fuser', str(LOCK), check=False).stdout.split()
    if len(holders) != 1 or not holders[0].isdigit():
        raise RuntimeError('CATALOG_PAUSE_LOCK_HOLDER_CHANGED')
    pid = int(holders[0])
    cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    if len(cmdline) < 4 or not cmdline[0].decode(errors='ignore').endswith('python3') \
            or cmdline[1:3] != [b'-u', b'-']:
        raise RuntimeError('CATALOG_PAUSE_LOCK_HOLDER_CHANGED')
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not Path(f'/proc/{pid}').exists():
            break
        time.sleep(1)
    else:
        raise RuntimeError('CATALOG_PAUSE_RECOVERY_DID_NOT_STOP')
    with LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.Image}}|{{.State.Status}}').stdout.strip()
        if runtime != IMAGE + '|' + IMAGE_ID + '|running':
            raise RuntimeError('CATALOG_PAUSE_DEPLOYMENT_CHANGED')
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode == 0:
            raise RuntimeError('CATALOG_PAUSE_CRON_ACTIVE')
        ids = catalog_ids()
        database = find_database(ids)
        validate_isolated_state(database, ids)
        replace_marker({'stage': 'paused', 'catalogRunIds': ids, 'pausedAt': int(time.time()),
                        'reason': 'worker-only-isolation-required'})
    print('CATALOG_RECOVERY_PAUSED=yes', flush=True)
    print('CATALOG_RECOVERY_OUTPUTS=0', flush=True)
    print('CATALOG_CRON_REMAINS_HELD=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_PAUSE_FAILED', file=sys.stderr)
        sys.exit(1)
