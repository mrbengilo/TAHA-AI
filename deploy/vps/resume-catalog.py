"""Resume the authorized prepare-only SKU catalog after Google re-consent."""
import fcntl
import base64
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
IMAGE = 'tahashoes-taha-ai:010c0193ab4ed57991a60e17aee2925a729ac117'
MARKER = Path('/var/lib/taha-ai/ops-recovery/catalog-lifestyle-v3.json')
APPLIED = Path('/var/lib/taha-ai/ops-recovery/catalog-recovery-v3-applied.json')
PROMPT_VERSION = 'taha-lifestyle-v3'
WRITE_SCOPES = {'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'}
VARIANTS = {'cycling', 'running', 'climbing', 'stream'}
RECOVERABLE_ERRORS = {'GOOGLE_WRITE_SCOPE_REQUIRED', 'CONNECTION_NOT_FOUND', 'OPENAI_RATE_LIMITED'}


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


def marker_run_ids(data):
    products = data.get('products')
    if not isinstance(products, list) or len(products) != 15:
        raise RuntimeError('CATALOG_MARKER_COUNT_CHANGED')
    ids = [row.get('runId') for row in products if isinstance(row, dict)]
    if len(ids) != 15 or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
        raise RuntimeError('CATALOG_MARKER_INVALID')
    if len(set(ids)) != 15: raise RuntimeError('CATALOG_MARKER_DUPLICATE')
    return ids


def validate_run_contract(rows, expected_ids, marker_products=None):
    if {row['id'] for row in rows} != set(expected_ids): raise RuntimeError('CATALOG_RUN_SET_CHANGED')
    expected_products = None
    if marker_products is not None:
        expected_products = {(row.get('runId'), row.get('productId'), row.get('sku')) for row in marker_products}
    unexpected = [
        {'sku': row.get('base_sku'), 'status': row.get('status'), 'code': row.get('error_code')}
        for row in rows
        if row.get('status') == 'cancelled'
        or (row.get('status') == 'failed' and row.get('error_code') not in RECOVERABLE_ERRORS)
    ]
    if unexpected:
        print('CATALOG_UNEXPECTED_STATES=' + json.dumps(unexpected, separators=(',', ':')), flush=True)
        raise RuntimeError('CATALOG_RUN_UNEXPECTED_FAILURE')
    for row in rows:
        try: content = json.loads(row['content_json'] or '{}')
        except ValueError: raise RuntimeError('CATALOG_RUN_CONTENT_INVALID') from None
        if content.get('prepareOnly') is not True or row['requested_image_count'] != 4 \
                or row['prompt_version'] != PROMPT_VERSION \
                or not row['request_key'].startswith('catalog:' + PROMPT_VERSION + ':') \
                or json.loads(row['target_providers_json'] or '[]') != ['facebook'] \
                or content.get('targetConnections') != {}:
            raise RuntimeError('CATALOG_RUN_NOT_PREPARE_ONLY')
        if expected_products is not None and (row['id'], row['product_id'], row['base_sku']) not in expected_products:
            raise RuntimeError('CATALOG_MARKER_PRODUCT_MISMATCH')


def find_database(ids):
    placeholders = ','.join('?' for _ in ids)
    for path in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'automation_runs', 'channel_connections', 'publish_jobs', 'schedules', 'products',
                    'product_media', 'media_assets', 'content_drafts'}.issubset(tables): continue
            rows = [dict(row) for row in db.execute(
                f"SELECT r.id,r.product_id,r.request_key,r.status,r.error_code,r.requested_image_count,r.prompt_version,"
                f"r.content_json,r.target_providers_json,r.source_media_id,p.base_sku FROM automation_runs r "
                f"JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                f"WHERE r.workspace_id=? AND r.id IN ({placeholders})", [WORKSPACE, *ids])]
            marker_products = json.loads(MARKER.read_text()).get('products', [])
            validate_run_contract(rows, ids, marker_products)
            connections = [dict(row) for row in db.execute(
                "SELECT id,status,scopes_json,last_error,auth_ciphertext,auth_iv FROM channel_connections "
                "WHERE workspace_id=? AND provider='google'",
                (WORKSPACE,))]
            ready = []
            for row in connections:
                try: scopes = set(json.loads(row['scopes_json'] or '[]'))
                except ValueError: scopes = set()
                if row['status'] == 'connected' and scopes.intersection(WRITE_SCOPES): ready.append(row)
            if not ready: raise RuntimeError('GOOGLE_WRITE_GRANT_NOT_ACTIVE')
            ready_ids = {row['id'] for row in ready}
            source_connections = {row[0] for row in db.execute(
                f"SELECT DISTINCT m.source_connection_id FROM product_media pm "
                f"JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id "
                f"WHERE pm.workspace_id=? AND pm.product_id IN (SELECT product_id FROM automation_runs "
                f"WHERE workspace_id=? AND id IN ({placeholders})) AND m.origin='source'",
                [WORKSPACE, WORKSPACE, *ids])}
            if len(source_connections) != 1 or not source_connections.issubset(ready_ids):
                raise RuntimeError('CATALOG_GOOGLE_CONNECTION_MISMATCH')
            unsafe = db.execute(
                f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
                [WORKSPACE, *['automation:' + value for value in ids]]).fetchone()[0]
            if unsafe: raise RuntimeError('CATALOG_PREPARE_ONLY_HAS_SCHEDULES')
            return path, next(row for row in ready if row['id'] in source_connections)
    raise RuntimeError('CATALOG_DATABASE_MISSING')


def read_runs(database, ids):
    placeholders = ','.join('?' for _ in ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(
            f"SELECT r.id,r.product_id,p.base_sku,r.status,r.error_code,r.completed_image_count "
            f"FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
            f"WHERE r.workspace_id=? AND r.id IN ({placeholders}) ORDER BY r.created_at", [WORKSPACE, *ids])]


def competing_active_runs(database, ids):
    placeholders = ','.join('?' for _ in ids)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            f"SELECT r.id,p.base_sku,r.request_key,r.status,r.error_code,r.requested_image_count,"
            f"r.target_providers_json,r.content_json,r.created_at FROM automation_runs r "
            f"JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
            f"WHERE r.workspace_id=? AND r.product_id IN (SELECT product_id FROM automation_runs "
            f"WHERE workspace_id=? AND id IN ({placeholders})) AND r.id NOT IN ({placeholders}) "
            f"AND r.status IN ('queued','processing') ORDER BY r.created_at",
            [WORKSPACE, WORKSPACE, *ids, *ids])]
    result = []
    for row in rows:
        try: content = json.loads(row['content_json'] or '{}')
        except ValueError: content = {}
        try: providers = json.loads(row['target_providers_json'] or '[]')
        except ValueError: providers = []
        result.append({'idB64': base64.b64encode(row['id'].encode()).decode(),
                       'sku': row['base_sku'], 'kind': row['request_key'].split(':', 1)[0],
                       'status': row['status'], 'code': row['error_code'],
                       'prepareOnly': content.get('prepareOnly') is True,
                       'targets': providers, 'images': row['requested_image_count'],
                       'createdAt': row['created_at']})
    return result


def retryable_ids(rows):
    for row in rows:
        if row['status'] == 'failed' and row.get('error_code') not in RECOVERABLE_ERRORS:
            raise RuntimeError('CATALOG_RUN_UNEXPECTED_FAILURE')
        if row['status'] == 'cancelled': raise RuntimeError('CATALOG_RUN_UNEXPECTED_FAILURE')
    return [row['id'] for row in rows if row['status'] == 'failed']


def save_marker(existing, progress, verified):
    value = {**existing, 'recovery': {'progress': progress, 'verified': verified, 'updatedAt': int(time.time())}}
    temporary = MARKER.with_suffix('.recovery-tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, MARKER)


def write_applied(value):
    fd = os.open(APPLIED, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, separators=(',', ':')); output.flush(); os.fsync(output.fileno())
    directory = os.open(APPLIED.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def media_type_allowed(content_type, generated):
    return content_type == 'image/jpeg' if generated else content_type in ('image/jpeg', 'image/png', 'image/webp')


def download_and_verify(secret, image, ceiling, generated):
    route = image.get('previewUrl', '')
    if not route.startswith('/api/media/') or '://' in route: raise RuntimeError('CATALOG_MEDIA_ROUTE_INVALID')
    request = Request('http://127.0.0.1:8787' + route, headers={'Authorization': 'Bearer ' + secret})
    with urlopen(request, timeout=90) as response:
        content_type = response.headers.get_content_type()
        content = response.read(ceiling + 1)
    if not media_type_allowed(content_type, generated) or not content or len(content) >= ceiling \
            or len(content) != image.get('byteSize'):
        raise RuntimeError('CATALOG_MEDIA_BYTES_MISMATCH')


def verify_product(secret, product_id):
    folder = api(secret, '/api/products/' + product_id, timeout=90)
    originals, generated = folder['images'], folder['generatedImages']
    if folder.get('validationError') or folder.get('imageValidationError'):
        raise RuntimeError('CATALOG_FOLDER_VALIDATION_FAILED')
    if not originals or any(not image['optimized'] or not 0 < image['byteSize'] < 300000 for image in originals):
        raise RuntimeError('CATALOG_ORIGINAL_IMAGE_LIMIT_FAILED')
    if len(generated) != 4 or {image.get('variant') for image in generated} != VARIANTS \
            or any(not 0 < image['byteSize'] < 200000 for image in generated):
        raise RuntimeError('CATALOG_GENERATED_IMAGE_LIMIT_FAILED')
    for image in originals: download_and_verify(secret, image, 300000, False)
    for image in generated: download_and_verify(secret, image, 200000, True)
    receipt = {'sku': folder['product']['base_sku'], 'originalImages': len(originals),
               'generatedImages': len(generated), 'maxOriginalBytes': max(image['byteSize'] for image in originals),
               'maxGeneratedBytes': max(image['byteSize'] for image in generated)}
    print('CATALOG_SKU_VERIFIED=' + json.dumps(receipt, separators=(',', ':')), flush=True)
    return receipt


def verify_google_token(connection):
    payload = json.dumps({'ciphertext': connection['auth_ciphertext'], 'iv': connection['auth_iv']})
    script = r"""
const fs = require('fs');
const { webcrypto } = require('crypto');
const env = Object.fromEntries(fs.readFileSync('/app/.dev.vars', 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^['\"]|['\"]$/g, '')];
}));
(async () => {
  const input = JSON.parse(await new Promise((resolve, reject) => { let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => resolve(value)); process.stdin.on('error', reject); }));
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY, 'base64url'), {name:'AES-GCM'}, false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({name:'AES-GCM', iv:Buffer.from(input.iv,'base64url'), additionalData:new TextEncoder().encode('taha-ai:integration-token:v1'), tagLength:128}, key, Buffer.from(input.ciphertext,'base64url'));
  const token = JSON.parse(new TextDecoder().decode(plain)).accessToken;
  if (typeof token !== 'string' || !token) process.exit(2);
  const signal = AbortSignal.timeout(15000);
  const infoResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), {signal});
  if (!infoResponse.ok) process.exit(3);
  const info = await infoResponse.json();
  const scopes = new Set(String(info.scope || '').split(/\s+/));
  if (info.aud !== env.GOOGLE_CLIENT_ID || (!scopes.has('https://www.googleapis.com/auth/drive') && !scopes.has('https://www.googleapis.com/auth/drive.file'))) process.exit(4);
  const drive = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {headers:{authorization:'Bearer ' + token}, signal:AbortSignal.timeout(15000)});
  if (!drive.ok) process.exit(5);
  process.stdout.write('verified');
})().catch(() => process.exit(6));
"""
    result = subprocess.run(['docker', 'exec', '-i', 'taha-ai', 'node', '-e', script], input=payload,
                            capture_output=True, text=True, timeout=45)
    if result.returncode or result.stdout != 'verified': raise RuntimeError('GOOGLE_WRITE_TOKEN_NOT_ACTIVE')


def validate_final_drafts(rows, ids):
    if len(rows) != len(ids) or {row['run_id'] for row in rows} != set(ids):
        raise RuntimeError('CATALOG_DRAFT_COUNT_INVALID')
    if any(row['status'] != 'draft' or row['total'] != 1 for row in rows):
        raise RuntimeError('CATALOG_DRAFT_STATE_INVALID')


def main():
    with open('/var/lock/taha-ai-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = subprocess.run(['docker', 'inspect', 'taha-ai', '--format', '{{.Config.Image}}|{{.State.Status}}'],
                                 check=True, capture_output=True, text=True, timeout=30).stdout.strip()
        if runtime != IMAGE + '|running': raise RuntimeError('CATALOG_DEPLOYMENT_CHANGED')
        digest = subprocess.run(['docker', 'inspect', 'taha-ai', '--format', '{{.Image}}'], check=True,
                                capture_output=True, text=True, timeout=30).stdout.strip()
        print('CATALOG_RUNTIME_IMAGE_B64=' + base64.b64encode(digest.encode()).decode(), flush=True)
        if not MARKER.exists(): raise RuntimeError('CATALOG_MARKER_MISSING')
        marker = json.loads(MARKER.read_text())
        ids = marker_run_ids(marker)
        database, google_connection = find_database(ids)
        secret = read_secret()
        verify_google_token(google_connection)
        print('CATALOG_COMPETING_ACTIVE_RUNS=' + json.dumps(
            competing_active_runs(database, ids), separators=(',', ':')), flush=True)
        was_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'taha-ai-cron.timer']).returncode == 0
        if not was_active: raise RuntimeError('CATALOG_CRON_TIMER_INACTIVE')
        try:
            subprocess.run(['systemctl', 'stop', 'taha-ai-cron.timer'], check=True, timeout=30)
            for _ in range(60):
                service = subprocess.run(['systemctl', 'show', 'taha-ai-cron.service', '-p', 'ActiveState', '--value'],
                                         check=True, capture_output=True, text=True, timeout=15).stdout.strip()
                if service not in ('active', 'activating', 'deactivating'): break
                time.sleep(1)
            else: raise RuntimeError('CATALOG_CRON_DRAIN_TIMEOUT')
            drained_database, drained_connection = find_database(ids)
            if drained_database != database or drained_connection['id'] != google_connection['id']:
                raise RuntimeError('CATALOG_STATE_CHANGED_DURING_DRAIN')
            initial = read_runs(database, ids)
            print('CATALOG_PRE_RETRY_STATES=' + json.dumps([
                {'sku': row['base_sku'], 'status': row['status'], 'code': row.get('error_code'),
                 'images': row['completed_image_count']} for row in initial
            ], separators=(',', ':')), flush=True)
            retry_ids = retryable_ids(initial)
            if APPLIED.exists():
                applied = json.loads(APPLIED.read_text())
                if applied.get('runIds') != ids: raise RuntimeError('CATALOG_RECOVERY_MARKER_MISMATCH')
                print('CATALOG_APPLIED_MARKER=' + json.dumps({
                    'stage': applied.get('stage'), 'retryCount': len(applied.get('retryIds', []))
                }, separators=(',', ':')), flush=True)
                if applied.get('stage') != 'applied':
                    raise RuntimeError('CATALOG_RECOVERY_PARTIAL_APPLY')
                retry_ids = []
            elif retry_ids:
                write_applied({'runIds': ids, 'retryIds': retry_ids, 'stage': 'planned', 'createdAt': int(time.time())})
                for run_id in retry_ids: api(secret, '/api/automation-runs/' + run_id + '/retry', {})
                temporary = APPLIED.with_suffix('.tmp')
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump({'runIds': ids, 'retryIds': retry_ids, 'stage': 'applied', 'appliedAt': int(time.time())}, output,
                              separators=(',', ':')); output.flush(); os.fsync(output.fileno())
                os.replace(temporary, APPLIED)
        finally:
            if was_active:
                subprocess.run(['systemctl', 'start', 'taha-ai-cron.timer'], check=True, timeout=30)
        print('CATALOG_GOOGLE_WRITE_GRANT_ACTIVE=yes', flush=True)
        print('CATALOG_RUNS_RETRIED=' + str(len(retry_ids)), flush=True)
        verified = {}
        previous = None
        deadline = time.monotonic() + 5.5 * 60 * 60
        while time.monotonic() < deadline:
            rows = read_runs(database, ids)
            for row in rows:
                if row['status'] == 'completed' and row['product_id'] not in verified:
                    verified[row['product_id']] = verify_product(secret, row['product_id'])
            progress = {'total': len(rows), 'completed': sum(row['status'] == 'completed' for row in rows),
                        'failed': sum(row['status'] in ('failed', 'cancelled') for row in rows),
                        'generatedImages': sum(row['completed_image_count'] for row in rows)}
            if progress != previous:
                print('CATALOG_RECOVERY_PROGRESS=' + json.dumps(progress, separators=(',', ':')), flush=True)
                save_marker(marker, progress, verified); previous = progress
            if len(rows) == 15 and all(row['status'] in ('completed', 'failed', 'cancelled') for row in rows): break
            time.sleep(15)
        rows = read_runs(database, ids)
        failed = [{'skuRun': row['id'], 'code': row.get('error_code')} for row in rows if row['status'] != 'completed']
        if failed:
            print('CATALOG_RECOVERY_FAILURES=' + json.dumps(failed, separators=(',', ':')), flush=True)
            raise RuntimeError('CATALOG_RECOVERY_INCOMPLETE')
        if len(verified) != 15: raise RuntimeError('CATALOG_VERIFICATION_INCOMPLETE')
        placeholders = ','.join('?' for _ in ids)
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            schedules = db.execute(f"SELECT count(*) FROM schedules WHERE workspace_id=? AND created_by IN ({placeholders})",
                                   [WORKSPACE, *['automation:' + value for value in ids]]).fetchone()[0]
            jobs = db.execute(f"SELECT count(*) FROM publish_jobs j JOIN schedules s ON s.id=j.schedule_id "
                              f"WHERE j.workspace_id=? AND s.created_by IN ({placeholders})",
                              [WORKSPACE, *['automation:' + value for value in ids]]).fetchone()[0]
            drafts = [dict(zip(('run_id', 'status', 'total'), row)) for row in db.execute(
                f"SELECT json_extract(generation_meta_json,'$.automationRunId'),status,count(*) FROM content_drafts "
                f"WHERE workspace_id=? AND json_extract(generation_meta_json,'$.automationRunId') IN ({placeholders}) "
                f"GROUP BY json_extract(generation_meta_json,'$.automationRunId'),status", [WORKSPACE, *ids])]
            validate_final_drafts(drafts, ids)
            if schedules or jobs: raise RuntimeError('CATALOG_PREPARE_ONLY_FINAL_STATE_INVALID')
        print('CATALOG_ALL_15_SKUS_VERIFIED=yes', flush=True)
        print('CATALOG_GENERATED_IMAGES_VERIFIED=60', flush=True)
        print('CATALOG_PREPARE_ONLY_VERIFIED=yes', flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', message) else 'CATALOG_RECOVERY_FAILED', file=sys.stderr)
        sys.exit(1)
