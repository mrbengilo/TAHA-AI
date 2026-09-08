"""Queue the verified 15-SKU Facebook catalog, one SKU per Vietnam day."""
import fcntl
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

WORKSPACE = '00000000-0000-4000-8000-000000000001'
REVISION = '4ef44959e6ffd29d966136922e3857c6a2119b86'
SKUS = ['PH0014', 'PH0015', 'PH0018', 'PH0020', 'PH0021', 'PH0022', 'PH0023', 'PH0024',
        'PH0027', 'PH0028', 'PH0029', 'PH0058', 'PH0059', 'PH0060', 'PH0072']
BACKUP_ROOT = Path('/var/backups/taha-ai')
RECEIPT = Path('/var/lib/taha-ai/ops-recovery/catalog-exact-sku-size-v1.json')


def command(*args, check=True, timeout=45):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def read_secret():
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip() == 'INTERNAL_API_SECRET':
            result = value.strip().strip('\"\'')
            if result:
                return result
    raise RuntimeError('EXACT_CATALOG_INTERNAL_SECRET_MISSING')


def api(token, path, body, timeout=120):
    request = Request('http://127.0.0.1:8787' + path, method='POST', data=json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except HTTPError as error:
        try:
            code = json.load(error).get('error', {}).get('code')
        except (ValueError, AttributeError):
            code = None
        safe = code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', code) else 'HTTP_' + str(error.code)
        raise RuntimeError('EXACT_CATALOG_API_' + safe) from None
    except (OSError, ValueError):
        raise RuntimeError('EXACT_CATALOG_API_UNAVAILABLE') from None
    data = payload.get('data')
    if not isinstance(data, dict):
        raise RuntimeError('EXACT_CATALOG_API_INVALID')
    return data


def database():
    placeholders = ','.join('?' for _ in SKUS)
    required = {'products', 'product_media', 'media_assets', 'automation_runs', 'publish_jobs'}
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required.issubset(tables):
                continue
            count = db.execute(
                f"SELECT count(*) FROM products WHERE workspace_id=? AND base_sku IN ({placeholders}) "
                "AND status='active' AND deleted_at IS NULL", [WORKSPACE, *SKUS],
            ).fetchone()[0]
            if count == len(SKUS):
                return path
    raise RuntimeError('EXACT_CATALOG_DATABASE_MISSING')


def product_rows(path):
    placeholders = ','.join('?' for _ in SKUS)
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        active = db.execute(
            f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND status IN ('queued','processing') "
            f"AND product_id IN (SELECT id FROM products WHERE workspace_id=? AND base_sku IN ({placeholders}))",
            [WORKSPACE, WORKSPACE, *SKUS],
        ).fetchone()[0]
        jobs = db.execute("SELECT count(*) FROM publish_jobs WHERE workspace_id=? AND status IN ('queued','processing','retry_wait')",
                          [WORKSPACE]).fetchone()[0]
        if active or jobs:
            raise RuntimeError('EXACT_CATALOG_ACTIVE_WORK_EXISTS')
        values = db.execute(
            f"SELECT p.id,p.base_sku,p.metadata_json,count(DISTINCT m.id) AS source_images "
            f"FROM products p LEFT JOIN product_media pm ON pm.product_id=p.id AND pm.workspace_id=p.workspace_id "
            f"LEFT JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=p.workspace_id "
            f"AND m.media_type='image' AND m.origin='source' AND m.storage_provider='google_drive' AND m.status='ready' "
            f"WHERE p.workspace_id=? AND p.base_sku IN ({placeholders}) AND p.status='active' AND p.deleted_at IS NULL "
            f"GROUP BY p.id,p.base_sku,p.metadata_json ORDER BY p.base_sku",
            [WORKSPACE, *SKUS],
        ).fetchall()
    rows = []
    for value in values:
        try:
            metadata = json.loads(value['metadata_json'] or '{}')
        except ValueError:
            metadata = {}
        website = metadata.get('website') if isinstance(metadata.get('website'), dict) else {}
        sizes = website.get('sizes') if isinstance(website.get('sizes'), list) else []
        source_images = int(value['source_images'])
        if not sizes:
            raise RuntimeError('EXACT_CATALOG_SIZE_MISSING_' + value['base_sku'])
        if source_images < 1 or source_images > 20:
            raise RuntimeError('EXACT_CATALOG_SOURCE_IMAGE_COUNT_INVALID')
        rows.append({'productId': value['id'], 'sku': value['base_sku'],
                     'sizes': [str(item) for item in sizes], 'sourceImages': source_images})
    if len(rows) != len(SKUS) or {row['sku'] for row in rows} != set(SKUS):
        raise RuntimeError('EXACT_CATALOG_SKU_SET_CHANGED')
    return sorted(rows, key=lambda row: (row['sourceImages'] < 6, row['sku']))


def backup_database(path):
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    target = BACKUP_ROOT / ('catalog-exact-sku-size-' + str(int(time.time())) + '.sqlite')
    with sqlite3.connect(path) as source, sqlite3.connect(target) as destination:
        source.backup(destination)
    os.chmod(target, 0o600)
    return str(target)


def save_receipt(value):
    RECEIPT.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = RECEIPT.with_name(RECEIPT.name + '.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False, separators=(',', ':'))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, RECEIPT)
    os.chmod(RECEIPT, 0o600)


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = command('docker', 'inspect', 'taha-ai', '--format',
                          '{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}').stdout.strip()
        if runtime != 'tahashoes-taha-ai:' + REVISION + '|' + REVISION + '|running':
            raise RuntimeError('EXACT_CATALOG_PRODUCTION_REVISION_MISMATCH')
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode == 0:
            raise RuntimeError('EXACT_CATALOG_CRON_EXPECTED_INACTIVE')
        database_path = database()
        rows = product_rows(database_path)
        backup = backup_database(database_path)
        first_day = datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).date() + timedelta(days=1)
        token = read_secret()
        queued = []
        for index, row in enumerate(rows):
            day = (first_day + timedelta(days=index)).isoformat()
            data = api(token, '/api/automation-runs', {
                'productId': row['productId'],
                'targetProviders': ['facebook'],
                'imageCount': 4,
                'prepareOnly': False,
                'idempotencyKey': 'daily:' + day + ':exact-sku-size-v1:' + row['sku'],
            })
            run = data.get('run') if isinstance(data.get('run'), dict) else {}
            expected_images = min(4, max(0, 6 - row['sourceImages']))
            if run.get('productId') != row['productId'] or run.get('requestedImageCount') != expected_images \
                    or run.get('status') not in ('queued', 'processing'):
                raise RuntimeError('EXACT_CATALOG_QUEUE_RESPONSE_INVALID')
            queued.append({'runId': run.get('id'), 'sku': row['sku'], 'sizes': row['sizes'],
                           'sourceImages': row['sourceImages'], 'generatedImages': expected_images,
                           'publishDay': day, 'replayed': data.get('replayed') is True})
        receipt = {'stage': 'queued', 'revision': REVISION, 'backup': backup, 'products': queued,
                   'updatedAt': int(time.time())}
        save_receipt(receipt)
        command('systemctl', 'start', 'taha-ai-cron.timer')
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode != 0:
            raise RuntimeError('EXACT_CATALOG_CRON_START_FAILED')
        receipt['stage'] = 'processing'
        receipt['updatedAt'] = int(time.time())
        save_receipt(receipt)
        print('EXACT_CATALOG_QUEUED=' + json.dumps({'products': queued, 'cronTimer': 'active'},
              ensure_ascii=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    try:
        main()
    except BlockingIOError:
        print('EXACT_CATALOG_RELEASE_LOCKED', file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'EXACT_CATALOG_QUEUE_FAILED', file=sys.stderr)
        raise SystemExit(1)
