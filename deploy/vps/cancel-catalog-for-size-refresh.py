"""Quarantine the exact 15-run catalog batch before SKU/size code rollout.

No rows are deleted. Drafts are rejected, schedules are paused, unfinished runs
are cancelled, and a SQLite backup plus a mode-0600 receipt are retained.
"""
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
REVISION = 'ffc61121076d49bb6b9044940990f509af57efef'
IMAGE = 'tahashoes-taha-ai:' + REVISION
IMAGE_ID = 'sha256:f4410ccaf9fbc932de004a15ca5e2b017f5ba87ce772a7e3b86a2d8f0824760d'
LOCK = Path('/var/lock/taha-ai-release.lock')
CATALOG = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
RECEIPT = Path('/var/lib/taha-ai/ops-recovery/catalog-size-refresh-v1.json')
BACKUP_ROOT = Path('/var/backups/taha-ai')
EXPECTED_COMPETITOR = 'eedbea4c-e66b-4c28-bc1a-a603c21c0830'


def command(*args, check=True, timeout=45):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def catalog_ids():
    products = json.loads(CATALOG.read_text()).get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_SIZE_REFRESH_MARKER_CHANGED')
    ids = [row.get('runId') for row in products if isinstance(row, dict)]
    if len(ids) != 15 or len(set(ids)) != 15 \
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
        raise RuntimeError('CATALOG_SIZE_REFRESH_MARKER_CHANGED')
    return ids


def find_database(ids):
    placeholders = ','.join('?' for _ in ids)
    required = {'automation_runs', 'automation_steps', 'content_drafts', 'schedules', 'publish_jobs'}
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required.issubset(tables):
                continue
            count = db.execute(
                f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})",
                [WORKSPACE, *ids],
            ).fetchone()[0]
            if count == 15:
                return path
    raise RuntimeError('CATALOG_SIZE_REFRESH_DATABASE_MISSING')


def lock_holders():
    result = command('fuser', str(LOCK), check=False)
    if result.returncode == 1:
        return []
    if result.returncode != 0:
        raise RuntimeError('CATALOG_SIZE_REFRESH_LOCK_INSPECTION_FAILED')
    pids = [int(value) for value in re.findall(r'\d+', result.stdout)]
    if len(pids) != 1:
        raise RuntimeError('CATALOG_SIZE_REFRESH_LOCK_OWNER_INVALID')
    try:
        parts = [value.decode() for value in Path(f'/proc/{pids[0]}/cmdline').read_bytes().split(b'\0') if value]
    except (OSError, UnicodeDecodeError):
        raise RuntimeError('CATALOG_SIZE_REFRESH_LOCK_OWNER_INVALID') from None
    if len(parts) < 3 or not Path(parts[0]).name.startswith('python3') or parts[1:3] != ['-u', '-']:
        raise RuntimeError('CATALOG_SIZE_REFRESH_LOCK_OWNER_INVALID')
    return pids


def acquire_lock(timeout=60):
    lock = LOCK.open('a')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            time.sleep(0.25)
    lock.close()
    raise RuntimeError('CATALOG_SIZE_REFRESH_PROCESS_DID_NOT_STOP')


def replace_receipt(value):
    RECEIPT.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = RECEIPT.with_name(RECEIPT.name + '.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, separators=(',', ':'))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, RECEIPT)
    os.chmod(RECEIPT, 0o600)


def snapshot(db, ids):
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    run_states = dict(db.execute(
        f"SELECT status,count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders}) GROUP BY status",
        [WORKSPACE, *ids],
    ))
    drafts = db.execute(
        f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders})",
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
    competitors = db.execute(
        f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id NOT IN ({placeholders}) "
        f"AND product_id IN (SELECT product_id FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})) "
        f"AND status IN ('queued','processing')",
        [WORKSPACE, *ids, WORKSPACE, *ids],
    ).fetchone()[0]
    return {'runs': run_states, 'drafts': drafts, 'schedules': schedules, 'publishJobs': jobs, 'competitors': competitors}


def quarantine(database, ids):
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    now = int(time.time() * 1000)
    with sqlite3.connect(database) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        before = snapshot(db, ids)
        if before['publishJobs'] != 0 or before['competitors'] != 0:
            db.rollback()
            raise RuntimeError('CATALOG_SIZE_REFRESH_ISOLATION_LOST')
        db.execute(
            f"UPDATE schedules SET status='paused',next_run_at=NULL,updated_at=? "
            f"WHERE workspace_id=? AND created_by IN ({','.join('?' for _ in creators)}) AND status IN ('draft','active')",
            [now, WORKSPACE, *creators],
        )
        db.execute(
            f"UPDATE content_drafts SET status='rejected',rejection_reason=?,updated_at=? "
            f"WHERE workspace_id=? AND json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders}) "
            f"AND status IN ('draft','in_review','approved')",
            ['Regenerate after exact SKU and size validation', now, WORKSPACE, *ids],
        )
        db.execute(
            f"UPDATE automation_steps SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? "
            f"WHERE workspace_id=? AND run_id IN ({placeholders}) AND status IN ('queued','retry_wait','processing')",
            ['PRODUCT_CONTENT_REQUIRES_SKU_SIZE_REFRESH', now, WORKSPACE, *ids],
        )
        db.execute(
            f"UPDATE automation_runs SET status='cancelled',error_code=?,error_message=NULL,updated_at=?,completed_at=? "
            f"WHERE workspace_id=? AND id IN ({placeholders}) AND status IN ('queued','processing')",
            ['PRODUCT_CONTENT_REQUIRES_SKU_SIZE_REFRESH', now, now, WORKSPACE, *ids],
        )
        after = snapshot(db, ids)
        active_schedules = db.execute(
            f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({','.join('?' for _ in creators)}) AND status='active'",
            [WORKSPACE, *creators],
        ).fetchone()[0]
        active_runs = db.execute(
            f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders}) AND status IN ('queued','processing')",
            [WORKSPACE, *ids],
        ).fetchone()[0]
        publishable_drafts = db.execute(
            f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders}) "
            f"AND status IN ('draft','in_review','approved')",
            [WORKSPACE, *ids],
        ).fetchone()[0]
        if active_schedules or active_runs or publishable_drafts or after['publishJobs']:
            db.rollback()
            raise RuntimeError('CATALOG_SIZE_REFRESH_QUARANTINE_INCOMPLETE')
        db.commit()
    return before, after


def quarantine_ids(database, catalog_run_ids):
    placeholders = ','.join('?' for _ in catalog_run_ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        competitors = [row[0] for row in db.execute(
            f"SELECT id FROM automation_runs WHERE workspace_id=? AND id NOT IN ({placeholders}) "
            f"AND product_id IN (SELECT product_id FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})) "
            f"AND status IN ('queued','processing') ORDER BY id",
            [WORKSPACE, *catalog_run_ids, WORKSPACE, *catalog_run_ids],
        )]
    if competitors not in ([], [EXPECTED_COMPETITOR]):
        raise RuntimeError('CATALOG_SIZE_REFRESH_COMPETITOR_CHANGED')
    return catalog_run_ids + competitors


def wait_for_app():
    for _ in range(60):
        automation = command('curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3',
                             'http://127.0.0.1:8787/automation', check=False, timeout=8).stdout.strip()
        api = command('curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3',
                      'http://127.0.0.1:8787/api/integrations', check=False, timeout=8).stdout.strip()
        if automation == '200' and api == '401':
            return
        time.sleep(1)
    raise RuntimeError('CATALOG_SIZE_REFRESH_RESTART_FAILED')


def main():
    command('systemctl', 'stop', 'taha-ai-cron.timer')
    holders = lock_holders()
    for pid in holders:
        os.kill(pid, signal.SIGTERM)
    with acquire_lock():
        runtime = command('docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.Image}}|{{.State.Status}}').stdout.strip()
        if runtime != IMAGE + '|' + IMAGE_ID + '|running':
            raise RuntimeError('CATALOG_SIZE_REFRESH_DEPLOYMENT_CHANGED')
        catalog_run_ids = catalog_ids()
        database = find_database(catalog_run_ids)
        ids = quarantine_ids(database, catalog_run_ids)
        stopped = False
        try:
            command('docker', 'stop', '--time', '30', 'taha-ai', timeout=45)
            stopped = True
            BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
            backup = BACKUP_ROOT / ('catalog-size-refresh-' + str(int(time.time())) + '.sqlite')
            with sqlite3.connect(database) as source, sqlite3.connect(backup) as target:
                source.backup(target)
            os.chmod(backup, 0o600)
            before, after = quarantine(database, ids)
            replace_receipt({'stage': 'database-quarantined', 'revision': REVISION,
                             'catalogRunIds': catalog_run_ids, 'quarantinedRunIds': ids,
                             'before': before, 'after': after, 'backup': str(backup),
                             'updatedAt': int(time.time())})
        finally:
            if stopped:
                command('docker', 'start', 'taha-ai')
                wait_for_app()
        receipt = {'stage': 'quarantined', 'revision': REVISION, 'catalogRunIds': catalog_run_ids,
                   'quarantinedRunIds': ids,
                   'before': before, 'after': after, 'backup': str(backup), 'updatedAt': int(time.time())}
        replace_receipt(receipt)
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode == 0:
            raise RuntimeError('CATALOG_SIZE_REFRESH_CRON_ACTIVE')
    print('CATALOG_SIZE_REFRESH_QUARANTINED=yes', flush=True)
    print('CATALOG_SIZE_REFRESH_RECOVERY_TERMINATED=' + ('yes' if holders else 'already-stopped'), flush=True)
    print('CATALOG_SIZE_REFRESH_BEFORE=' + json.dumps(before, separators=(',', ':')), flush=True)
    print('CATALOG_SIZE_REFRESH_AFTER=' + json.dumps(after, separators=(',', ':')), flush=True)
    print('CATALOG_SIZE_REFRESH_CRON_HELD=yes', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_SIZE_REFRESH_FAILED', file=sys.stderr)
        sys.exit(1)
