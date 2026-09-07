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
IMAGE = 'tahashoes-taha-ai:ffc61121076d49bb6b9044940990f509af57efef'
IMAGE_ID = 'sha256:f4410ccaf9fbc932de004a15ca5e2b017f5ba87ce772a7e3b86a2d8f0824760d'
REVISION = 'ffc61121076d49bb6b9044940990f509af57efef'
LOCK = Path('/var/lock/taha-ai-release.lock')
CATALOG = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
PAUSED = Path('/var/lib/taha-ai/ops-recovery/catalog-six-image-user-pause.json')


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
    return {'completed': completed, 'competitors': competitors, 'drafts': drafts,
            'schedules': schedules, 'publishJobs': jobs}


def is_recovery_cmdline(parts):
    return len(parts) >= 3 and Path(parts[0]).name.startswith('python3') and parts[1:3] == ['-u', '-']


def recovery_lock_holders():
    result = command('fuser', str(LOCK), check=False)
    if result.returncode == 1: return []
    if result.returncode != 0: raise RuntimeError('CATALOG_PAUSE_LOCK_INSPECTION_FAILED')
    pids = [int(value) for value in re.findall(r'\d+', result.stdout)]
    if len(pids) != 1: raise RuntimeError('CATALOG_PAUSE_LOCK_OWNER_INVALID')
    try: parts = [value.decode() for value in Path(f'/proc/{pids[0]}/cmdline').read_bytes().split(b'\0') if value]
    except (OSError, UnicodeDecodeError): raise RuntimeError('CATALOG_PAUSE_LOCK_OWNER_INVALID') from None
    if not is_recovery_cmdline(parts): raise RuntimeError('CATALOG_PAUSE_LOCK_OWNER_INVALID')
    return pids


def acquire_recovery_lock(timeout=45):
    lock = LOCK.open('a')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            time.sleep(0.25)
    lock.close()
    raise RuntimeError('CATALOG_PAUSE_PROCESS_DID_NOT_STOP')


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
    holders = recovery_lock_holders()
    for pid in holders: os.kill(pid, signal.SIGTERM)
    with acquire_recovery_lock() as lock:
        runtime = command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.Image}}|{{.State.Status}}').stdout.strip()
        if runtime != IMAGE + '|' + IMAGE_ID + '|running':
            raise RuntimeError('CATALOG_PAUSE_DEPLOYMENT_CHANGED')
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode == 0:
            raise RuntimeError('CATALOG_PAUSE_CRON_ACTIVE')
        ids = catalog_ids()
        database = find_database(ids)
        state = validate_isolated_state(database, ids)
        if PAUSED.exists():
            marker = json.loads(PAUSED.read_text())
            if (PAUSED.stat().st_mode & 0o777) != 0o600 or marker.get('stage') != 'paused' \
                    or marker.get('catalogRunIds') != ids \
                    or marker.get('reason') != 'user-requested-until-tomorrow':
                raise RuntimeError('CATALOG_PAUSE_MARKER_CHANGED')
        else:
            replace_marker({'stage': 'paused', 'catalogRunIds': ids, 'pausedAt': int(time.time()),
                            'reason': 'user-requested-until-tomorrow', 'revision': REVISION})
    print('CATALOG_RECOVERY_PAUSED=yes', flush=True)
    print('CATALOG_RECOVERY_PROCESS_TERMINATED=' + ('yes' if holders else 'already-stopped'), flush=True)
    print('CATALOG_RECOVERY_SAFE_STATE=' + json.dumps(state, separators=(',', ':')), flush=True)
    print('CATALOG_CRON_REMAINS_HELD=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_PAUSE_FAILED', file=sys.stderr)
        sys.exit(1)
