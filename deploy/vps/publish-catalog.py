"""Finish the exact SKU/size Facebook catalog, ready SKUs first."""
import base64
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = '00000000-0000-4000-8000-000000000001'
REVISION = '4ef44959e6ffd29d966136922e3857c6a2119b86'
IMAGE = 'tahashoes-taha-ai:' + REVISION
LOCK = Path('/var/lock/taha-ai-release.lock')
CATALOG = Path('/var/lib/taha-ai/ops-recovery/catalog-exact-sku-size-v1.json')
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-exact-sku-size-progress-v1.json')
EXPECTED_COUNTS = {
    'PH0014': 2, 'PH0015': 0, 'PH0018': 0, 'PH0020': 4, 'PH0021': 0,
    'PH0022': 0, 'PH0023': 1, 'PH0024': 0, 'PH0027': 3, 'PH0028': 0,
    'PH0029': 0, 'PH0058': 4, 'PH0059': 4, 'PH0060': 4, 'PH0072': 4,
}
RECOVERABLE_ERRORS = {
    'GOOGLE_WRITE_SCOPE_REQUIRED', 'CONNECTION_NOT_FOUND', 'OPENAI_RATE_LIMITED',
    'GOOGLE_SYNC_IN_PROGRESS', 'GOOGLE_DRIVE_TEMPORARY_FAILURE',
    'GOOGLE_DRIVE_UNAVAILABLE', 'GOOGLE_SHEETS_UNAVAILABLE',
    'GOOGLE_SHEETS_REQUEST_FAILED', 'GOOGLE_MEDIA_TEMPORARY_FAILURE',
    'GOOGLE_MEDIA_UNAVAILABLE',
}
MAX_RETRIES = 3
WORKER_INTERVAL_SECONDS = 25
GROUP_TIMEOUT_SECONDS = 5 * 60 * 60
VN = timezone(timedelta(hours=7))


def command(*args, check=True, timeout=30):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def api(secret, path, body=None, timeout=300):
    request = Request('http://127.0.0.1:8787' + path, method='POST' if body is not None else 'GET',
                      data=None if body is None else json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response: result = json.load(response)
    except HTTPError as error:
        raise RuntimeError('CATALOG_API_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError('CATALOG_API_UNAVAILABLE') from None
    if not result.get('data'): raise RuntimeError('CATALOG_API_EMPTY_RESPONSE')
    return result['data']


def read_secret():
    settings = {}
    for line in Path('/etc/taha-ai/.dev.vars').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep: settings[key.strip()] = value.strip().strip('"\'')
    secret = settings.get('INTERNAL_API_SECRET')
    if not secret: raise RuntimeError('INTERNAL_API_SECRET_MISSING')
    return secret


def replace_marker(value):
    MARKER.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = MARKER.with_name(MARKER.name + '.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, separators=(',', ':'))
        output.flush(); os.fsync(output.fileno())
    os.replace(temporary, MARKER)
    directory = os.open(MARKER.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def validate_runtime():
    runtime = command('docker', 'inspect', 'taha-ai', '--format',
                      '{{.Config.Image}}|{{.State.Status}}|{{index .Config.Labels "org.opencontainers.image.revision"}}').stdout.strip()
    if runtime != '|'.join((IMAGE, 'running', REVISION)):
        raise RuntimeError('CATALOG_PUBLISH_DEPLOYMENT_CHANGED')
    print('CATALOG_RUNTIME_REVISION_B64=' + base64.b64encode(REVISION.encode()).decode(), flush=True)


def catalog_products():
    if not CATALOG.is_file() or (CATALOG.stat().st_mode & 0o777) != 0o600:
        raise RuntimeError('CATALOG_PUBLISH_MARKER_INVALID')
    products = json.loads(CATALOG.read_text()).get('products')
    if not isinstance(products, list) or len(products) != len(EXPECTED_COUNTS):
        raise RuntimeError('CATALOG_PUBLISH_MARKER_INVALID')
    cleaned = []
    for row in products:
        if not isinstance(row, dict) or row.get('sku') not in EXPECTED_COUNTS \
                or not re.fullmatch(r'[0-9a-f-]{36}', str(row.get('runId', ''))):
            raise RuntimeError('CATALOG_PUBLISH_MARKER_INVALID')
        sizes = row.get('sizes')
        day = row.get('publishDay')
        if not isinstance(sizes, list) or not sizes or any(not isinstance(size, str) or not size for size in sizes) \
                or not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) \
                or row.get('generatedImages') != EXPECTED_COUNTS[row['sku']]:
            raise RuntimeError('CATALOG_PUBLISH_MARKER_INVALID')
        cleaned.append({'runId': row['runId'], 'sku': row['sku'],
                        'sizes': sizes, 'publishDay': day})
    if len({row['runId'] for row in cleaned}) != len(cleaned) \
            or {row['sku'] for row in cleaned} != set(EXPECTED_COUNTS):
        raise RuntimeError('CATALOG_PUBLISH_MARKER_INVALID')
    return cleaned


def find_database(run_ids):
    placeholders = ','.join('?' for _ in run_ids)
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        try:
            with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                required = {'automation_runs', 'automation_steps', 'products', 'product_media', 'media_assets',
                            'channel_connections', 'content_drafts', 'content_draft_media', 'schedules', 'publish_jobs'}
                if not required.issubset(tables): continue
                found = db.execute(
                    f"SELECT count(*) FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})",
                    [WORKSPACE, *run_ids]).fetchone()[0]
                if found == len(run_ids): return path
        except sqlite3.Error:
            continue
    raise RuntimeError('CATALOG_PUBLISH_DATABASE_MISSING')


def read_runs(database, run_ids):
    placeholders = ','.join('?' for _ in run_ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(
            f"SELECT r.id,r.product_id,p.base_sku,p.status AS product_status,r.request_key,r.status,r.error_code,"
            f"r.requested_image_count,r.completed_image_count,r.output_media_ids_json,r.content_json,r.target_providers_json "
            f"FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
            f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) ORDER BY p.base_sku", [WORKSPACE, *run_ids])]


def hydrate_products(database, products):
    rows = {row['id']: row for row in read_runs(database, [item['runId'] for item in products])}
    hydrated = []
    for item in products:
        run = rows.get(item['runId'])
        if not run or run['base_sku'] != item['sku'] or not re.fullmatch(r'[0-9a-f-]{36}', run['product_id']):
            raise RuntimeError('CATALOG_PUBLISH_RUN_SET_CHANGED')
        hydrated.append({**item, 'productId': run['product_id']})
    if len({item['productId'] for item in hydrated}) != len(hydrated):
        raise RuntimeError('CATALOG_PUBLISH_RUN_SET_CHANGED')
    return hydrated


def source_counts(database, run_ids):
    placeholders = ','.join('?' for _ in run_ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        return dict(db.execute(
            f"SELECT p.base_sku,count(DISTINCT m.id) FROM automation_runs r "
            f"JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
            f"JOIN product_media pm ON pm.product_id=p.id AND pm.workspace_id=p.workspace_id "
            f"JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id "
            f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) AND m.origin='source' "
            f"AND m.media_type='image' AND m.status='ready' GROUP BY p.base_sku", [WORKSPACE, *run_ids]))


def validate_initial_state(database, products, allow_promoted=False):
    ids = [row['runId'] for row in products]
    rows = read_runs(database, ids)
    if len(rows) != len(products): raise RuntimeError('CATALOG_PUBLISH_RUN_SET_CHANGED')
    expected_identity = {(row['runId'], row['productId'], row['sku']) for row in products}
    counts = source_counts(database, ids)
    for row in rows:
        if (row['id'], row['product_id'], row['base_sku']) not in expected_identity \
                or row['product_status'] != 'active' or json.loads(row['target_providers_json'] or '[]') != ['facebook']:
            raise RuntimeError('CATALOG_PUBLISH_RUN_SET_CHANGED')
        if row['requested_image_count'] != EXPECTED_COUNTS[row['base_sku']] \
                or EXPECTED_COUNTS[row['base_sku']] != min(4, max(0, 6 - counts.get(row['base_sku'], 0))):
            raise RuntimeError('CATALOG_PUBLISH_IMAGE_PLAN_CHANGED')
        if row['completed_image_count'] != 0 or json.loads(row['output_media_ids_json'] or '[]'):
            raise RuntimeError('CATALOG_PUBLISH_OUTPUT_ALREADY_EXISTS')
        content = json.loads(row['content_json'] or '{}')
        unpromoted = content.get('prepareOnly') is True and content.get('targetConnections') == {} \
            and row['request_key'].startswith('catalog:taha-lifestyle-v3:')
        promoted = content.get('prepareOnly') is False and isinstance(content.get('targetConnections', {}).get('facebook'), str) \
            and row['request_key'].startswith('daily:')
        if not unpromoted and not (allow_promoted and promoted):
            raise RuntimeError('CATALOG_PUBLISH_RUN_CONTRACT_CHANGED')
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        competitors = db.execute(
            f"SELECT count(*) FROM automation_runs r WHERE r.workspace_id=? AND r.id NOT IN ({placeholders}) "
            f"AND r.product_id IN (SELECT product_id FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})) "
            f"AND r.status IN ('queued','processing')", [WORKSPACE, *ids, WORKSPACE, *ids]).fetchone()[0]
        drafts = db.execute(
            f"SELECT count(*) FROM content_drafts WHERE workspace_id=? AND json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders})",
            [WORKSPACE, *ids]).fetchone()[0]
        schedules = db.execute(
            f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
            [WORKSPACE, *creators]).fetchone()[0]
        jobs = db.execute(
            f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id AND s.workspace_id=j.workspace_id "
            f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})", [WORKSPACE, *creators]).fetchone()[0]
    if competitors or drafts or schedules or jobs:
        raise RuntimeError('CATALOG_PUBLISH_ISOLATION_LOST')
    return rows, counts


def validate_promoted_state(database, products, marker):
    ids = [row['runId'] for row in products]
    rows = read_runs(database, ids)
    expected_identity = {(row['runId'], row['productId'], row['sku']) for row in products}
    planned = {row['runId']: row for row in marker['plan']}
    if len(rows) != len(products): raise RuntimeError('CATALOG_PUBLISH_RUN_SET_CHANGED')
    for row in rows:
        item = planned.get(row['id'])
        content = json.loads(row['content_json'] or '{}')
        if not item or (row['id'], row['product_id'], row['base_sku']) not in expected_identity \
                or row['product_status'] != 'active' or row['request_key'] != item['requestKey'] \
                or row['requested_image_count'] != item['requestedImages'] \
                or json.loads(row['target_providers_json'] or '[]') != ['facebook'] \
                or content.get('prepareOnly') is not False \
                or content.get('targetConnections') != {'facebook': marker['connectionId']} \
                or row['status'] not in ('queued', 'processing', 'completed', 'failed'):
            raise RuntimeError('CATALOG_PUBLISH_PROMOTION_STATE_CHANGED')
        if row['status'] == 'failed' and row.get('error_code') not in RECOVERABLE_ERRORS:
            raise RuntimeError('CATALOG_PUBLISH_UNEXPECTED_FAILURE')
    placeholders = ','.join('?' for _ in ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        competitors = db.execute(
            f"SELECT count(*) FROM automation_runs r WHERE r.workspace_id=? AND r.id NOT IN ({placeholders}) "
            f"AND r.product_id IN (SELECT product_id FROM automation_runs WHERE workspace_id=? AND id IN ({placeholders})) "
            f"AND r.status IN ('queued','processing')", [WORKSPACE, *ids, WORKSPACE, *ids]).fetchone()[0]
    if competitors: raise RuntimeError('CATALOG_PUBLISH_ISOLATION_LOST')
    return rows


def build_plan(products, now=None):
    ordered = sorted(products, key=lambda row: (EXPECTED_COUNTS[row['sku']] != 0, row['sku']))
    result = []
    for row in ordered:
        day = datetime.strptime(row['publishDay'], '%Y-%m-%d').date()
        run_at = int(datetime(day.year, day.month, day.day, 8, 0, tzinfo=VN).timestamp() * 1000)
        result.append({**row, 'requestedImages': EXPECTED_COUNTS[row['sku']], 'day': day.isoformat(),
                       'runAt': run_at,
                       'requestKey': f"daily:{day.isoformat()}:exact-sku-size-v1:{row['sku']}"})
    return result


def load_or_create_plan(products, connection_id):
    if not MARKER.exists():
        marker = {'version': 1, 'stage': 'planned', 'connectionId': connection_id,
                  'plan': build_plan(products), 'retryAttempts': {}, 'createdAt': int(time.time())}
        replace_marker(marker)
        return marker
    if not MARKER.is_file() or (MARKER.stat().st_mode & 0o777) != 0o600:
        raise RuntimeError('CATALOG_PUBLISH_PLAN_INVALID')
    marker = json.loads(MARKER.read_text())
    allowed = {'planned', 'promoted', 'priority_complete', 'completed'}
    if marker.get('version') != 1 or marker.get('stage') not in allowed or marker.get('connectionId') != connection_id \
            or not isinstance(marker.get('plan'), list) or len(marker['plan']) != len(products) \
            or not isinstance(marker.get('retryAttempts'), dict):
        raise RuntimeError('CATALOG_PUBLISH_PLAN_INVALID')
    identities = {(row['runId'], row['productId'], row['sku'], tuple(row['sizes'])) for row in products}
    if {(row.get('runId'), row.get('productId'), row.get('sku'), tuple(row.get('sizes') or [])) for row in marker['plan']} != identities \
            or [row.get('requestedImages') for row in marker['plan']] != [EXPECTED_COUNTS[row['sku']] for row in marker['plan']] \
            or len({row.get('day') for row in marker['plan']}) != len(products):
        raise RuntimeError('CATALOG_PUBLISH_PLAN_INVALID')
    return marker


def facebook_connection(database, secret):
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        rows = db.execute("SELECT id FROM channel_connections WHERE workspace_id=? AND provider='facebook' "
                          "AND status='connected' AND publish_mode='api'", (WORKSPACE,)).fetchall()
    if len(rows) != 1: raise RuntimeError('CATALOG_FACEBOOK_CONNECTION_AMBIGUOUS')
    connection_id = rows[0][0]
    verified = api(secret, '/api/integrations/facebook/verify', {'connectionId': connection_id}, timeout=90)
    if verified.get('ready') is not True or verified.get('code') or verified.get('missingScopes'):
        raise RuntimeError('CATALOG_FACEBOOK_PERMISSION_NOT_READY')
    print('CATALOG_FACEBOOK_PERMISSION_READY=yes', flush=True)
    return connection_id


def promote(database, marker):
    plan = {row['runId']: row for row in marker['plan']}
    with sqlite3.connect(database, timeout=30) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            for run_id, item in plan.items():
                row = db.execute("SELECT request_key,content_json,status FROM automation_runs WHERE id=? AND workspace_id=?",
                                 (run_id, WORKSPACE)).fetchone()
                if not row or row[2] not in ('queued', 'processing', 'failed'):
                    raise RuntimeError('CATALOG_PUBLISH_PROMOTION_STATE_CHANGED')
                content = json.loads(row[1] or '{}')
                if row[0] == item['requestKey'] and content.get('prepareOnly') is False \
                        and content.get('targetConnections') == {'facebook': marker['connectionId']}:
                    continue
                if not row[0].startswith('catalog:taha-lifestyle-v3:') or content.get('prepareOnly') is not True \
                        or content.get('targetConnections') != {}:
                    raise RuntimeError('CATALOG_PUBLISH_PROMOTION_STATE_CHANGED')
                content['prepareOnly'] = False
                content['targetConnections'] = {'facebook': marker['connectionId']}
                changed = db.execute(
                    "UPDATE automation_runs SET request_key=?,content_json=?,updated_at=? WHERE id=? AND workspace_id=? "
                    "AND request_key=? AND content_json=? AND status IN ('queued','processing','failed')",
                    (item['requestKey'], json.dumps(content, separators=(',', ':')), int(time.time() * 1000),
                     run_id, WORKSPACE, row[0], row[1])).rowcount
                if changed != 1: raise RuntimeError('CATALOG_PUBLISH_PROMOTION_CAS_FAILED')
            db.commit()
        except Exception:
            db.rollback(); raise


def retry_failed(secret, database, group, marker):
    failed = [row for row in read_runs(database, group) if row['status'] == 'failed']
    for row in failed:
        if row.get('error_code') not in RECOVERABLE_ERRORS:
            raise RuntimeError('CATALOG_PUBLISH_UNEXPECTED_FAILURE')
        attempts = dict(marker['retryAttempts'])
        used = attempts.get(row['id'], 0)
        if used >= MAX_RETRIES: raise RuntimeError('CATALOG_PUBLISH_RETRY_BUDGET_EXHAUSTED')
        attempts[row['id']] = used + 1
        marker = {**marker, 'retryAttempts': attempts, 'lastRetryAt': int(time.time())}
        replace_marker(marker)
        time.sleep(60)
        response = api(secret, '/api/automation-runs/' + row['id'] + '/retry', {})
        if (response.get('run') or {}).get('status') not in ('processing', 'queued'):
            raise RuntimeError('CATALOG_PUBLISH_RETRY_NOT_APPLIED')
        print('CATALOG_PUBLISH_RETRY=' + json.dumps({'sku': row['base_sku'], 'attempt': used + 1}, separators=(',', ':')), flush=True)
    return marker


def verify_group(database, plan):
    ids = [row['runId'] for row in plan]
    placeholders = ','.join('?' for _ in ids)
    creators = ['automation:' + value for value in ids]
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            f"SELECT r.id,p.base_sku,r.status,r.requested_image_count,r.completed_image_count,d.status AS draft_status,"
            f"count(DISTINCT d.id) AS drafts,count(DISTINCT s.id) AS schedules,count(DISTINCT dm.media_id) AS media_count,"
            f"min(s.status) AS schedule_status,min(s.run_at) AS run_at,min(s.next_run_at) AS next_run_at,"
            f"min(d.body) AS body FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
            f"LEFT JOIN content_drafts d ON d.workspace_id=r.workspace_id AND json_extract(d.generation_meta_json,'$.automationRunId')=r.id "
            f"LEFT JOIN content_draft_media dm ON dm.workspace_id=d.workspace_id AND dm.draft_id=d.id "
            f"LEFT JOIN schedules s ON s.workspace_id=r.workspace_id AND s.created_by='automation:' || r.id "
            f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) GROUP BY r.id,p.base_sku,r.status,r.requested_image_count,"
            f"r.completed_image_count,d.status", [WORKSPACE, *ids])]
        jobs = db.execute(
            f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id AND s.workspace_id=j.workspace_id "
            f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})", [WORKSPACE, *creators]).fetchone()[0]
    if len(rows) != len(plan) or jobs:
        raise RuntimeError('CATALOG_PUBLISH_FINAL_STATE_INVALID')
    expected = {row['runId']: row for row in plan}
    forbidden = ('google drive', 'google sheets', 'nguồn ảnh', 'kiểm tra đúng mã sản phẩm',
                 'giá bán', 'giá tham khảo', ' vnd', ' vnđ', '₫')
    for row in rows:
        item = expected[row['id']]
        raw_body = str(row.get('body') or '')
        body = raw_body.lower()
        sku_tokens = set(re.findall(r'\bPH\d{4}\b', raw_body.upper()))
        exact_size_line = '📏 Size hiện có: ' + ', '.join(item['sizes'])
        if row['base_sku'] != item['sku'] or row['status'] != 'completed' \
                or row['requested_image_count'] != item['requestedImages'] \
                or row['completed_image_count'] != item['requestedImages'] \
                or row['draft_status'] != 'approved' or row['drafts'] != 1 or row['schedules'] != 1 \
                or row['schedule_status'] != 'active' or row['run_at'] != item['runAt'] \
                or row['next_run_at'] != item['runAt'] or not 1 <= row['media_count'] <= 6 \
                or not body or any(value in body for value in forbidden) \
                or '🏷️ Mã sản phẩm: ' + item['sku'] not in raw_body \
                or exact_size_line not in raw_body or sku_tokens != {item['sku']} \
                or len(raw_body.split()) > 2000:
            raise RuntimeError('CATALOG_PUBLISH_FINAL_STATE_INVALID')
    return [{'sku': row['base_sku'], 'tag': 'Đã lên lịch', 'runAt': expected[row['id']]['day']} for row in rows]


def run_group(secret, database, plan, marker, label):
    ids = [row['runId'] for row in plan]
    deadline = time.monotonic() + GROUP_TIMEOUT_SECONDS
    previous = None
    while time.monotonic() < deadline:
        rows = read_runs(database, ids)
        progress = {'group': label, 'completed': sum(row['status'] == 'completed' for row in rows),
                    'total': len(rows), 'generatedImages': sum(row['completed_image_count'] for row in rows)}
        if progress != previous:
            print('CATALOG_PUBLISH_PROGRESS=' + json.dumps(progress, separators=(',', ':')), flush=True)
            previous = progress
        if all(row['status'] == 'completed' for row in rows):
            receipt = verify_group(database, plan)
            print('CATALOG_GROUP_READY_AND_SCHEDULED=' + json.dumps(receipt, ensure_ascii=False, separators=(',', ':')), flush=True)
            return marker
        if any(row['status'] in ('failed', 'cancelled') for row in rows):
            if any(row['status'] == 'cancelled' for row in rows):
                raise RuntimeError('CATALOG_PUBLISH_UNEXPECTED_FAILURE')
            marker = retry_failed(secret, database, ids, marker)
            previous = None
            continue
        tick = api(secret, '/api/internal/automation/tick', {'runIds': ids}, timeout=300)
        errors = tick.get('automation', {}).get('errors', [])
        if errors: print('CATALOG_PUBLISH_WORKER_ERRORS=' + json.dumps(errors, separators=(',', ':')), flush=True)
        time.sleep(WORKER_INTERVAL_SECONDS)
    raise RuntimeError('CATALOG_PUBLISH_GROUP_TIMEOUT')


def main():
    with LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_runtime()
        command('systemctl', 'stop', 'taha-ai-cron.timer')
        for _ in range(120):
            state = command('systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value').stdout.strip()
            if state not in ('active', 'activating', 'deactivating'): break
            time.sleep(1)
        else: raise RuntimeError('CATALOG_PUBLISH_CRON_DRAIN_TIMEOUT')
        products = catalog_products()
        ids = [row['runId'] for row in products]
        database = find_database(ids)
        products = hydrate_products(database, products)
        secret = read_secret()
        connection_id = facebook_connection(database, secret)
        marker = load_or_create_plan(products, connection_id)
        if marker['stage'] == 'planned':
            marker = {**marker, 'stage': 'promoted', 'promotedAt': int(time.time())}
            replace_marker(marker)
        validate_promoted_state(database, products, marker)
        priority = [row for row in marker['plan'] if row['requestedImages'] == 0]
        remaining = [row for row in marker['plan'] if row['requestedImages'] > 0]
        if marker['stage'] in ('priority_complete', 'completed'):
            verify_group(database, priority)
        if marker['stage'] == 'promoted':
            marker = run_group(secret, database, priority, marker, 'ready-six-images')
            marker = {**marker, 'stage': 'priority_complete', 'priorityCompletedAt': int(time.time())}
            replace_marker(marker)
        if marker['stage'] == 'priority_complete':
            marker = run_group(secret, database, remaining, marker, 'generate-remaining')
            marker = {**marker, 'stage': 'completed', 'completedAt': int(time.time())}
            replace_marker(marker)
        if marker['stage'] != 'completed': raise RuntimeError('CATALOG_PUBLISH_PLAN_INVALID')
        verify_group(database, marker['plan'])
        validate_runtime()
        command('systemctl', 'start', 'taha-ai-cron.timer')
        if command('systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer', check=False).returncode != 0:
            raise RuntimeError('CATALOG_PUBLISH_CRON_RESTORE_FAILED')
        print('CATALOG_ALL_15_READY=yes', flush=True)
        print('CATALOG_ALL_15_SCHEDULED=yes', flush=True)
        print('CATALOG_SCHEDULE_FIRST=' + marker['plan'][0]['day'], flush=True)
        print('CATALOG_SCHEDULE_LAST=' + marker['plan'][-1]['day'], flush=True)
        print('CATALOG_CRON_RESTORED=yes', flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_PUBLISH_FAILED', file=sys.stderr)
        sys.exit(1)
